import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, posix } from 'path'
import { RemoteAPIError } from 'tensorlake'
import { TensorlakeClient } from './client.js'
import { LOGIN_HINT, projectKeyWarning } from './credentials.js'
import { logger } from './logger.js'
import { toast } from './toast.js'
import type { ProjectSessionData } from './types.js'
import type { PluginInput } from '@opencode-ai/plugin'
import {
  resolveSyncMode,
  projectDirName,
  syncGitProject,
  syncBackFromSyncRepo,
  ensureVolumeWithProject,
  ensureVolumeMounted,
  mountedFileSystemId,
  refreshSandboxGitCredential,
  GIT_CREDENTIAL_REFRESH_MS,
} from './project-sync.js'

export class TensorlakeSessionManager {
  private readonly client: TensorlakeClient
  // In-memory cache: sessionId -> { sandboxId }
  private readonly cache = new Map<string, { sandboxId: string }>()
  // In-flight getSandbox promises keyed by sessionId — prevents concurrent double-resume
  private readonly inflight = new Map<string, Promise<{ sandboxId: string }>>()
  // Sandboxes whose project sync already ran in this process
  private readonly synced = new Set<string>()
  // In-flight sync promises keyed by sandboxId — prevents concurrent double-sync
  private readonly syncInflight = new Map<string, Promise<void>>()
  // Sandboxes confirmed to already contain the project dir (check runs once per process)
  private readonly hasProjectDir = new Set<string>()
  // Last failed sync attempt per sandbox — retried after a cooldown instead of on every tool call
  private readonly syncFailedAt = new Map<string, number>()
  private static readonly SYNC_RETRY_COOLDOWN_MS = 60_000
  // In-flight sync-back per worktree — session.idle can fire faster than a fetch completes
  private readonly syncBackInflight = new Map<string, Promise<void>>()
  // Last failed sync-back per worktree — retried after a cooldown instead of on every idle
  private readonly syncBackFailedAt = new Map<string, number>()
  // Sync repo commit already reported as "staged, not merged" per worktree — suppresses repeat toasts
  private readonly lastStagedOid = new Map<string, string>()
  // Keys already checked for project scope — the warning fires once per key
  private readonly warnedKeys = new Set<string>()
  // When each sandbox's git credential was last written — tokens expire in ~1h
  private readonly credRefreshedAt = new Map<string, number>()
  public readonly workDir: string
  private readonly storageDir: string

  constructor(resolveKey: () => string | undefined, storageDir: string, workDir: string) {
    this.client = new TensorlakeClient(resolveKey)
    this.storageDir = storageDir
    this.workDir = workDir
  }

  getClient(): TensorlakeClient {
    return this.client
  }

  /** Directory inside the sandbox where the local project is synced. */
  projectDir(worktree: string): string {
    if (resolveSyncMode(worktree) === 'off') return this.workDir
    // Guest (Linux sandbox) path — must stay POSIX even on a Windows host
    return posix.join(this.workDir, projectDirName(worktree))
  }

  /**
   * Sync the local project into the sandbox. Git repos are pushed to a
   * Tensorlake-hosted repo and cloned inside the sandbox; a folder that is
   * already a Tensorlake filesystem mount is attached to the sandbox as-is,
   * with no copy at all; any other plain folder is uploaded to a cloud volume
   * mounted into the sandbox. Failures are logged and surfaced but never block
   * the sandbox.
   */
  private async syncProject(sandboxId: string, projectId: string, worktree: string): Promise<void> {
    if (this.synced.has(sandboxId)) return
    const mode = resolveSyncMode(worktree)
    if (mode === 'off') {
      this.synced.add(sandboxId)
      return
    }
    const failedAt = this.syncFailedAt.get(sandboxId)
    if (failedAt !== undefined && Date.now() - failedAt < TensorlakeSessionManager.SYNC_RETRY_COOLDOWN_MS) return
    const destDir = this.projectDir(worktree)
    try {
      if (mode === 'git') {
        toast.show({ title: 'Syncing project', message: `Pushing ${worktree} and cloning into the sandbox...`, variant: 'info' })
        await syncGitProject(this.client, this.client.getApiKey(), sandboxId, worktree, projectId, destDir)
        // The sync script wrote a fresh credential into the sandbox.
        this.credRefreshedAt.set(sandboxId, Date.now())
      } else if (mode === 'mount') {
        // The local folder already *is* the filesystem, so there is nothing to
        // copy: the sandbox mounts the same one, and the mount daemon's
        // autosave carries writes both ways within a second or so.
        const fileSystemId = mountedFileSystemId(worktree)
        if (!fileSystemId) throw new Error(`No Tensorlake filesystem is mounted at ${worktree}`)
        toast.show({ title: 'Mounting project', message: `Mounting filesystem ${fileSystemId} into the sandbox...`, variant: 'info' })
        await ensureVolumeMounted(this.client, { fileSystemId, mountPath: destDir }, sandboxId)
      } else {
        toast.show({ title: 'Syncing project', message: `Uploading ${worktree} to a cloud volume...`, variant: 'info' })
        const mount = await ensureVolumeWithProject(this.client.getApiKey(), worktree, projectId, destDir, this.storageDir)
        await ensureVolumeMounted(this.client, mount, sandboxId)
      }
      this.synced.add(sandboxId)
      this.syncFailedAt.delete(sandboxId)
      toast.show({
        title: mode === 'mount' ? 'Project mounted' : 'Project synced',
        message:
          mode === 'mount'
            ? `${destDir} and ${worktree} are the same filesystem; changes flow both ways.`
            : `Project available at ${destDir}`,
        variant: 'success',
      })
    } catch (err: any) {
      this.syncFailedAt.set(sandboxId, Date.now())
      logger.error(`Project sync (${mode}) failed: ${err?.stack ?? err}`)
      // Tools default their working directory to destDir; create it so the
      // sandbox really is usable (but empty) while sync is failing.
      try {
        await this.client.executeCommand(sandboxId, `mkdir -p ${destDir}`, '/')
      } catch (mkdirErr) {
        logger.warn(`Failed to create project dir after sync failure: ${mkdirErr}`)
      }
      toast.show({ title: 'Project sync failed', message: `${err?.message ?? err}. Sandbox is usable but empty.`, variant: 'error' })
    }
  }

  /** Run syncProject at most once concurrently per sandbox. Never rejects (syncProject handles its own errors). */
  private syncProjectOnce(sandboxId: string, projectId: string, worktree: string): Promise<void> {
    const existing = this.syncInflight.get(sandboxId)
    if (existing) return existing
    const promise = this.syncProject(sandboxId, projectId, worktree)
      .finally(() => this.syncInflight.delete(sandboxId))
    this.syncInflight.set(sandboxId, promise)
    return promise
  }

  /**
   * Make sure tools can run against the project dir without always paying for
   * a full sync up front. If the sandbox already contains the project dir
   * (e.g. a resumed sandbox synced by an earlier process), the refresh sync
   * runs in the background; only a sandbox with no project copy at all blocks
   * on the initial sync.
   */
  private async ensureProjectAvailable(sandboxId: string, projectId: string, worktree: string): Promise<void> {
    if (this.synced.has(sandboxId)) {
      this.refreshGitCredentialIfStale(sandboxId, projectId, worktree)
      return
    }
    if (resolveSyncMode(worktree) === 'off') {
      this.synced.add(sandboxId)
      return
    }
    if (this.hasProjectDir.has(sandboxId)) {
      void this.syncProjectOnce(sandboxId, projectId, worktree)
      return
    }
    const destDir = this.projectDir(worktree)
    try {
      // The check runs BEFORE the sync starts, so it can never observe a
      // half-populated clone. In git mode it requires a .git dir: only then
      // does the sync script take its safe fast-forward path — without .git
      // it runs `rm -rf && git clone`, which must never execute behind the
      // agent's back (e.g. on the decoy dir the sync-failure fallback leaves,
      // after the agent has written files into it). In volume mode the dir
      // must be non-empty so that same empty decoy dir does not count.
      const mode = resolveSyncMode(worktree)
      // In mount mode the answer is whether the filesystem is mounted, which
      // ensureVolumeMounted already establishes cheaply and exactly — so skip
      // the guess and let the sync run.
      if (mode === 'mount') {
        await this.syncProjectOnce(sandboxId, projectId, worktree)
        return
      }
      const checkCmd = mode === 'git'
        ? `[ -d '${destDir}/.git' ]`
        : `[ -d '${destDir}' ] && [ -n "$(ls -A '${destDir}' 2>/dev/null)" ]`
      const check = await this.client.executeCommand(sandboxId, checkCmd, '/', 15_000)
      if (check.exitCode === 0) {
        this.hasProjectDir.add(sandboxId)
        void this.syncProjectOnce(sandboxId, projectId, worktree)
        return
      }
    } catch (err) {
      logger.warn(`Failed to check for existing project dir: ${err}`)
    }
    await this.syncProjectOnce(sandboxId, projectId, worktree)
  }

  /**
   * Re-mint the sandbox's stored git credential when the last one is near
   * expiry (tokens last about an hour). Fire-and-forget: a turn never blocks
   * on it, and a failed refresh is retried on the next turn.
   */
  private refreshGitCredentialIfStale(sandboxId: string, projectId: string, worktree: string): void {
    if (resolveSyncMode(worktree) !== 'git') return
    const last = this.credRefreshedAt.get(sandboxId) ?? 0
    if (Date.now() - last < GIT_CREDENTIAL_REFRESH_MS) return
    // Claim the slot up front so concurrent tool calls don't stack refreshes.
    this.credRefreshedAt.set(sandboxId, Date.now())
    refreshSandboxGitCredential(this.client, this.client.getApiKey(), sandboxId, projectId)
      .then(() => logger.info(`Refreshed git credential in sandbox ${sandboxId}`))
      .catch((err: any) => {
        this.credRefreshedAt.delete(sandboxId)
        logger.warn(`Failed to refresh git credential in sandbox ${sandboxId}: ${err?.message ?? err}`)
      })
  }

  /**
   * Pull agent commits from the sync repo back into the local checkout.
   * Runs after each agent turn (session.idle) so a "commit and push" by the
   * agent lands on the user's local branch within seconds; a turn where the
   * agent pushed nothing costs one cheap fetch. Only sessions that actually
   * have a sandbox in this process trigger it, and only in git mode.
   */
  async syncBack(sessionId: string, projectId: string, worktree: string): Promise<void> {
    if (!this.cache.has(sessionId)) return
    if (resolveSyncMode(worktree) !== 'git') return
    const failedAt = this.syncBackFailedAt.get(worktree)
    if (failedAt !== undefined && Date.now() - failedAt < TensorlakeSessionManager.SYNC_RETRY_COOLDOWN_MS) return
    const existing = this.syncBackInflight.get(worktree)
    if (existing) return existing
    const run = this._syncBack(worktree, projectId).finally(() => this.syncBackInflight.delete(worktree))
    this.syncBackInflight.set(worktree, run)
    return run
  }

  private async _syncBack(worktree: string, projectId: string): Promise<void> {
    try {
      const result = await syncBackFromSyncRepo(this.client.getApiKey(), worktree, projectId)
      if (result.kind === 'fast-forwarded') {
        this.lastStagedOid.delete(worktree)
        logger.info(`Sync-back: fast-forwarded local ${result.branch} by ${result.commits} agent commit(s)`)
        toast.show({
          title: 'Agent work pulled',
          message: `${result.commits} commit(s) from the sandbox are now on your local '${result.branch}' branch.`,
          variant: 'success',
        })
      } else if (result.kind === 'staged' && result.oid !== this.lastStagedOid.get(worktree)) {
        this.lastStagedOid.set(worktree, result.oid)
        logger.info(`Sync-back: staged ${result.commits} agent commit(s) on ${result.ref} (${result.reason})`)
        toast.show({
          title: 'Agent work fetched',
          message: `${result.commits} commit(s) are on '${result.ref}' but not merged (${result.reason}). Merge when ready: git merge ${result.ref}`,
          variant: 'warning',
        })
      }
    } catch (err: any) {
      this.syncBackFailedAt.set(worktree, Date.now())
      logger.warn(`Sync-back from sync repo failed: ${err?.message ?? err}`)
    }
  }

  private storagePath(projectId: string): string {
    return join(this.storageDir, `${projectId}.json`)
  }

  private loadProjectData(projectId: string): ProjectSessionData | null {
    try {
      const path = this.storagePath(projectId)
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, 'utf-8')) as ProjectSessionData
    } catch {
      return null
    }
  }

  private saveProjectData(data: ProjectSessionData): void {
    try {
      if (!existsSync(this.storageDir)) mkdirSync(this.storageDir, { recursive: true })
      writeFileSync(this.storagePath(data.projectId), JSON.stringify(data, null, 2))
    } catch (err) {
      logger.error(`Failed to save project data: ${err}`)
    }
  }

  private updateSession(
    projectId: string,
    worktree: string,
    sessionId: string,
    sandboxId: string,
  ): void {
    const existing = this.loadProjectData(projectId) ?? { projectId, worktree, sessions: {} }
    existing.sessions[sessionId] = {
      sandboxId,
      created: existing.sessions[sessionId]?.created ?? Date.now(),
      lastAccessed: Date.now(),
    }
    this.saveProjectData(existing)
  }

  private removeSession(projectId: string, sessionId: string): void {
    const data = this.loadProjectData(projectId)
    if (!data) return
    delete data.sessions[sessionId]
    this.saveProjectData(data)
  }

  getSandbox(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<{ sandboxId: string }> {
    const existing = this.inflight.get(sessionId)
    if (existing) return existing
    const promise = this._getSandbox(sessionId, projectId, worktree, pluginCtx)
      .catch((err: unknown) => {
        throw this.asLoginError(err)
      })
      .finally(() => this.inflight.delete(sessionId))
    this.inflight.set(sessionId, promise)
    return promise
  }

  // Login cannot validate the key (OpenCode masks it away from the plugin),
  // so a wrong or revoked key first surfaces here as a 401/403 from the
  // management API. Turn it into the log-in-again toast the README promises
  // instead of leaking a raw SDK error.
  private asLoginError(err: unknown): unknown {
    if (!(err instanceof RemoteAPIError) || ![401, 403].includes(err.statusCode)) return err
    const msg = `Tensorlake rejected the API key (HTTP ${err.statusCode}). ${LOGIN_HINT}`
    logger.error(msg)
    toast.show({ title: 'Tensorlake login required', message: msg, variant: 'error' })
    return new Error(msg)
  }

  private async _getSandbox(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<{ sandboxId: string }> {
    if (pluginCtx?.client?.tui) toast.initialize(pluginCtx.client.tui)

    if (!this.client.hasApiKey()) {
      const msg = `No Tensorlake credentials found. ${LOGIN_HINT}`
      logger.error(`Tool call blocked for session ${sessionId}: ${msg}`)
      toast.show({ title: 'Tensorlake login required', message: msg, variant: 'error' })
      throw new Error(msg)
    }

    // Login can no longer validate the key (OpenCode masks it away from the
    // plugin), so warn once per key when it doesn't look project-scoped.
    const apiKey = this.client.getApiKey()
    if (!this.warnedKeys.has(apiKey)) {
      this.warnedKeys.add(apiKey)
      const warning = projectKeyWarning(apiKey)
      if (warning) {
        logger.warn(warning)
        toast.show({ title: 'Check your Tensorlake API key', message: warning, variant: 'warning' })
      }
    }

    // Check in-memory cache
    const cached = this.cache.get(sessionId)
    if (cached) {
      try {
        const info = await this.client.getSandbox(cached.sandboxId)
        // 'timeout' is terminal like 'terminated' — waiting on it never ends in 'running'
        if (info.status === 'terminated' || info.status === 'timeout') {
          logger.warn(`Sandbox ${cached.sandboxId} is ${info.status}, creating new one`)
          this.cache.delete(sessionId)
          this.removeSession(projectId, sessionId)
          // Call _getSandbox directly: getSandbox would return the still-pending
          // in-flight promise for this session, resolving the promise to itself.
          return this._getSandbox(sessionId, projectId, worktree, pluginCtx)
        }
        if (info.status === 'suspended' || info.status === 'suspending') {
          logger.info(`Resuming sandbox ${cached.sandboxId} (was ${info.status})`)
          if (info.status === 'suspending') await this.client.waitForSuspended(cached.sandboxId)
          // resumeSandbox blocks until the sandbox is running again
          await this.client.resumeSandbox(cached.sandboxId)
          toast.show({ title: 'Sandbox resumed', message: 'Sandbox resumed from suspension.', variant: 'info' })
        } else if (info.status !== 'running') {
          await this.client.waitForRunning(cached.sandboxId)
        }
        this.updateSession(projectId, worktree, sessionId, cached.sandboxId)
        // No-op when already synced; retries a previously failed sync (after cooldown)
        await this.ensureProjectAvailable(cached.sandboxId, projectId, worktree)
        return cached
      } catch (err) {
        logger.warn(`Failed to check cached sandbox: ${err}`)
        this.cache.delete(sessionId)
      }
    }

    // Check persistent storage — first for this session, then for any session in the project
    const projectData = this.loadProjectData(projectId)
    const candidateSessions = projectData
      ? [
          ...(projectData.sessions[sessionId] ? [[sessionId, projectData.sessions[sessionId]] as const] : []),
          ...Object.entries(projectData.sessions)
            .filter(([id]) => id !== sessionId)
            .sort(([, a], [, b]) => b.lastAccessed - a.lastAccessed),
        ]
      : []

    for (const [storedSessionId, stored] of candidateSessions) {
      logger.info(`Trying sandbox ${stored.sandboxId} from session ${storedSessionId}`)
      try {
        const info = await this.client.getSandbox(stored.sandboxId)
        // 'timeout' is terminal like 'terminated' — waiting on it never ends in 'running'
        if (info.status === 'terminated' || info.status === 'timeout') {
          this.removeSession(projectId, storedSessionId)
          continue
        }
        if (info.status === 'suspended' || info.status === 'suspending') {
          logger.info(`Resuming sandbox ${stored.sandboxId} (was ${info.status})`)
          if (info.status === 'suspending') await this.client.waitForSuspended(stored.sandboxId)
          // resumeSandbox blocks until the sandbox is running again
          await this.client.resumeSandbox(stored.sandboxId)
        } else if (info.status !== 'running') {
          await this.client.waitForRunning(stored.sandboxId)
        }
        const entry = { sandboxId: stored.sandboxId }
        this.cache.set(sessionId, entry)
        this.updateSession(projectId, worktree, sessionId, stored.sandboxId)
        const reused = storedSessionId !== sessionId
        toast.show({ title: 'Sandbox connected', message: reused ? 'Reusing sandbox from previous session.' : 'Connected to existing sandbox.', variant: 'info' })
        await this.ensureProjectAvailable(stored.sandboxId, projectId, worktree)
        return entry
      } catch (err) {
        logger.warn(`Failed to connect to sandbox ${stored.sandboxId}: ${err}`)
        this.removeSession(projectId, storedSessionId)
      }
    }

    // Create new sandbox
    logger.info(`Creating new sandbox for session ${sessionId}`)
    const createStart = Date.now()
    const image = process.env.TENSORLAKE_IMAGE
    const sandboxName = `opencode-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
    const created = await this.client.createSandbox({ ...(image ? { image } : {}), name: sandboxName })
    logger.info(`Sandbox created ${created.sandbox_id} in ${Date.now() - createStart}ms`)

    // createAndConnect already waits for running; ensure workspace dir exists
    try {
      await this.client.executeCommand(created.sandbox_id, `mkdir -p ${this.workDir}`, '/')
    } catch (err) {
      logger.warn(`Failed to create workspace dir: ${err}`)
    }

    const entry = { sandboxId: created.sandbox_id }
    this.cache.set(sessionId, entry)
    this.updateSession(projectId, worktree, sessionId, created.sandbox_id)

    toast.show({ title: 'Sandbox created', message: 'New sandbox is ready.', variant: 'success' })
    // A fresh sandbox has no project copy — the sync must finish before tools run
    await this.syncProjectOnce(created.sandbox_id, projectId, worktree)
    return entry
  }

  suspendAllSandboxes(): void {
    for (const [sessionId, { sandboxId }] of this.cache.entries()) {
      logger.info(`Suspending sandbox ${sandboxId} for session ${sessionId} (app exit)`)
      try {
        this.client.suspendSandboxSync(sandboxId)
        logger.info(`Sandbox ${sandboxId} suspended`)
      } catch (err) {
        logger.error(`Failed to suspend sandbox ${sandboxId}: ${err}`)
      }
    }
  }

  async deleteSandbox(sessionId: string, projectId: string): Promise<void> {
    const cached = this.cache.get(sessionId)
    const projectData = this.loadProjectData(projectId)
    const stored = projectData?.sessions[sessionId]
    const sandboxId = cached?.sandboxId ?? stored?.sandboxId

    if (!sandboxId) {
      logger.warn(`No sandbox found for session ${sessionId}`)
      return
    }

    logger.info(`Deleting sandbox ${sandboxId} for session ${sessionId}`)
    await this.client.deleteSandbox(sandboxId)
    this.cache.delete(sessionId)
    this.removeSession(projectId, sessionId)
    logger.info(`Sandbox ${sandboxId} deleted`)
  }
}
