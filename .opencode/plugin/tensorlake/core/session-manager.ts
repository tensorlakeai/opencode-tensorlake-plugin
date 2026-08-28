import { RemoteAPIError } from 'tensorlake'
import type { FileSystemMount } from 'tensorlake'
import { COMMAND_TIMEOUT_MS, TensorlakeClient } from './client.js'
import { LOGIN_HINT, projectKeyWarning } from './credentials.js'
import { logger } from './logger.js'
import { toast } from './toast.js'
import { SessionTree } from './session-tree.js'
import { SessionStore } from './session-store.js'
import { resolveFileSystemMount, ensureFileSystemMounted, assertFileSystemExists } from './filesystem.js'
import { resolveGitRepo, bootstrapSandboxGit, GIT_CREDENTIAL_REFRESH_MS } from './git-bootstrap.js'
import type { PluginInput } from '@opencode-ai/plugin'

/**
 * What a delete request did. Only 'deleted' really tore a sandbox down — a
 * subagent session, or one whose sandbox another session still uses, is just
 * detached, and a session that never had a sandbox does nothing at all.
 */
export type DeleteOutcome = 'deleted' | 'detached' | 'none'

export class TensorlakeSessionManager {
  private readonly client: TensorlakeClient
  // In-memory cache: sessionId -> { sandboxId }
  private readonly cache = new Map<string, { sandboxId: string }>()
  // In-flight getSandbox promises keyed by sessionId — prevents concurrent double-resume
  private readonly inflight = new Map<string, Promise<{ sandboxId: string }>>()
  // Sandboxes whose workspace preparation (workdir, filesystem, git) ran in this process
  private readonly prepared = new Set<string>()
  // In-flight preparation per sandbox — concurrent tool calls share one run
  private readonly prepareInflight = new Map<string, Promise<void>>()
  // Keys already checked for project scope — the warning fires once per key
  private readonly warnedKeys = new Set<string>()
  // Session -> the session that owns its sandbox. Subagent sessions share
  // their parent's sandbox instead of each getting their own workspace;
  // see SessionTree.
  private readonly sessions = new SessionTree()
  // Sessions whose sandbox was (or is being) deleted — a late tool call must
  // fail instead of silently creating a fresh sandbox for a dead session
  private readonly deleting = new Set<string>()
  // In-flight deletion per session — a second session.deleted (or a manual
  // retry racing it) joins the first run instead of tearing down twice
  private readonly deleteInflight = new Map<string, Promise<DeleteOutcome>>()
  // Tool executions currently running, keyed by sessionId. Deletion waits for
  // them: terminating a sandbox mid-write loses the work in flight.
  private readonly activeTools = new Map<string, Set<Promise<void>>>()
  // Idle bound while deletion waits for leased tool calls. A whole tool call
  // has no fixed ceiling (apply_patch chains many bounded reads, writes, and
  // commands), so deletion waits for as long as the sandbox keeps starting or
  // settling operations and gives up only after this long with none. It must
  // outlast the longest single operation: a command may run for
  // COMMAND_TIMEOUT_MS and only marks activity when it starts and settles.
  // The margin covers file transfers and scheduling slack; the bound itself
  // only backstops a hung release.
  private static readonly DELETE_TOOL_IDLE_MS = COMMAND_TIMEOUT_MS + 30_000
  // When each sandbox's git credential was last written — tokens expire in ~1h
  private readonly credRefreshedAt = new Map<string, number>()
  // Background work that must finish before the process exits: sandbox
  // creation and deletion. Suspending a sandbox (or exiting) mid-flight can
  // orphan a sandbox, so shutdown() drains this set first.
  private readonly pending = new Set<Promise<void>>()
  // Subagent sessions already reported as sharing a parent's sandbox.
  private readonly sharedLogged = new Set<string>()
  // Set once shutdown starts — stops new fire-and-forget work from being
  // queued behind the drain.
  private shuttingDown = false
  // The single shutdown run; a second signal or event joins it.
  private shutdownRun: Promise<void> | undefined
  private static readonly DRAIN_TIMEOUT_MS = 15_000

  /** Drain budget for shutdown; TENSORLAKE_SHUTDOWN_DRAIN_MS overrides it. */
  private static drainBudgetMs(): number {
    const raw = Number(process.env.TENSORLAKE_SHUTDOWN_DRAIN_MS)
    if (Number.isFinite(raw) && raw >= 0) return raw
    return TensorlakeSessionManager.DRAIN_TIMEOUT_MS
  }
  public readonly workDir: string
  private readonly store: SessionStore
  // Configured Tensorlake filesystem to attach to every sandbox (optional)
  private fsMount: FileSystemMount | undefined
  // Configured Tensorlake-hosted git repository to bootstrap (optional)
  private gitRepo: string | undefined

  constructor(resolveKey: () => string | undefined, storageDir: string, workDir: string) {
    this.client = new TensorlakeClient(resolveKey)
    this.store = new SessionStore(storageDir)
    this.workDir = workDir
  }

  getClient(): TensorlakeClient {
    return this.client
  }

  /** Apply plugin options (env vars win inside each resolver). */
  configure(options: Record<string, unknown> | undefined): void {
    this.fsMount = resolveFileSystemMount(options, this.workDir)
    this.gitRepo = resolveGitRepo(options)
  }

  /** The configured filesystem mount, if any. */
  fileSystemMount(): FileSystemMount | undefined {
    return this.fsMount
  }

  /** The configured hosted git repository name, if any. */
  gitRepoName(): string | undefined {
    return this.gitRepo
  }

  /**
   * The session whose sandbox `sessionId` uses. A subagent session resolves to
   * its parent (up to the root), so a task and the agent that spawned it share
   * one workspace.
   */
  ownerSession(sessionId: string, pluginCtx?: PluginInput): Promise<string> {
    return this.sessions.root(sessionId, pluginCtx)
  }

  /** Record a parent link seen on a session event, so no lookup is needed. */
  noteSession(sessionId: string | undefined, parentId: string | undefined | null): void {
    this.sessions.note(sessionId, parentId)
  }

  /**
   * Directory tools run in by default: the filesystem mount when one is
   * configured, the plain workspace directory otherwise. The worktree
   * parameter is kept for call-site compatibility with the tools.
   */
  projectDir(_worktree: string): string {
    return this.fsMount?.mountPath ?? this.workDir
  }

  /**
   * Prepare a sandbox for tool calls, once per process per sandbox: create
   * the workspace directory, attach and wait for the configured filesystem,
   * and set up git credentials for the configured repository. A filesystem
   * failure blocks the tool call — running against a plain directory while
   * the user expects persistent storage silently loses work. A git bootstrap
   * failure only warns; the agent can still work, and the next tool call
   * retries the credential.
   */
  private prepareSandbox(sandboxId: string): Promise<void> {
    if (this.prepared.has(sandboxId)) return Promise.resolve()
    const existing = this.prepareInflight.get(sandboxId)
    if (existing) return existing
    const run = this._prepareSandbox(sandboxId).finally(() => this.prepareInflight.delete(sandboxId))
    this.prepareInflight.set(sandboxId, run)
    return this.track(run)
  }

  private async _prepareSandbox(sandboxId: string): Promise<void> {
    try {
      await this.client.executeCommand(sandboxId, `mkdir -p ${this.workDir}`, '/')
    } catch (err) {
      logger.warn(`Failed to create workspace dir: ${err}`)
    }
    if (this.fsMount) {
      try {
        await ensureFileSystemMounted(this.client, this.fsMount, sandboxId)
      } catch (err: any) {
        logger.error(`Filesystem attach failed: ${err?.message ?? err}`)
        toast.show({ title: 'Filesystem attach failed', message: `${err?.message ?? err}`, variant: 'error' })
        throw err
      }
    }
    if (this.gitRepo) {
      try {
        await bootstrapSandboxGit(this.client, this.client.getApiKey(), sandboxId, this.gitRepo)
        this.credRefreshedAt.set(sandboxId, Date.now())
      } catch (err: any) {
        logger.warn(`Git bootstrap for repository ${this.gitRepo} failed: ${err?.message ?? err}`)
        toast.show({
          title: 'Git setup failed',
          message: `Could not configure repository '${this.gitRepo}' in the sandbox: ${err?.message ?? err}`,
          variant: 'warning',
        })
        // Non-fatal: the sandbox is usable, and the next tool call retries.
        return
      }
    }
    this.prepared.add(sandboxId)
  }

  /**
   * Re-mint the sandbox's stored git credential when the last one is near
   * expiry (tokens last about an hour). Fire-and-forget: a turn never blocks
   * on it, and a failed refresh is retried on the next turn.
   */
  private refreshGitCredentialIfStale(sandboxId: string): void {
    if (!this.gitRepo || this.shuttingDown) return
    const last = this.credRefreshedAt.get(sandboxId) ?? 0
    if (Date.now() - last < GIT_CREDENTIAL_REFRESH_MS) return
    // Claim the slot up front so concurrent tool calls don't stack refreshes.
    this.credRefreshedAt.set(sandboxId, Date.now())
    void this.track(bootstrapSandboxGit(this.client, this.client.getApiKey(), sandboxId, this.gitRepo))
      .then(() => logger.info(`Refreshed git credential in sandbox ${sandboxId}`))
      .catch((err: any) => {
        this.credRefreshedAt.delete(sandboxId)
        logger.warn(`Failed to refresh git credential in sandbox ${sandboxId}: ${err?.message ?? err}`)
      })
  }

  private updateSession(projectId: string, worktree: string, sessionId: string, sandboxId: string): void {
    this.store.update(projectId, worktree, (data) => {
      data.sessions[sessionId] = {
        sandboxId,
        created: data.sessions[sessionId]?.created ?? Date.now(),
        lastAccessed: Date.now(),
      }
    })
  }

  private removeSession(projectId: string, sessionId: string): void {
    this.store.update(projectId, '', (data) => {
      if (!(sessionId in data.sessions)) return false
      delete data.sessions[sessionId]
    })
  }

  /**
   * The sandbox for a session. A subagent session is served the sandbox of the
   * session that spawned it, so the whole tree shares one workspace.
   */
  async getSandbox(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<{ sandboxId: string }> {
    const owner = await this.sessions.root(sessionId, pluginCtx)
    if (owner !== sessionId && !this.sharedLogged.has(sessionId)) {
      this.sharedLogged.add(sessionId)
      logger.info(`Session ${sessionId} is a subagent of ${owner}; routing its tool calls to the parent's sandbox`)
    }
    return this.getOwnerSandbox(owner, projectId, worktree, pluginCtx)
  }

  /** getSandbox for a session id already resolved to its sandbox owner. */
  private getOwnerSandbox(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<{ sandboxId: string }> {
    if (this.deleting.has(sessionId)) {
      return Promise.reject(new Error(`Session ${sessionId} was deleted; its sandbox is gone and will not be recreated.`))
    }
    const existing = this.inflight.get(sessionId)
    if (existing) return existing
    const promise = this._getSandbox(sessionId, projectId, worktree, pluginCtx)
      .catch((err: unknown) => {
        throw this.asLoginError(err)
      })
      .finally(() => this.inflight.delete(sessionId))
    this.inflight.set(sessionId, promise)
    return this.track(promise)
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
        // No-op when already prepared; retries a previously failed preparation
        await this.prepareSandbox(cached.sandboxId)
        this.refreshGitCredentialIfStale(cached.sandboxId)
        return cached
      } catch (err) {
        logger.warn(`Failed to check cached sandbox: ${err}`)
        this.cache.delete(sessionId)
      }
    }

    // Check persistent storage for this session only. Never adopt another
    // session's sandbox: sessions must stay isolated, and deleting either
    // session would tear down the shared sandbox.
    const projectData = this.store.read(projectId)
    const stored = projectData?.sessions[sessionId]

    if (stored) {
      logger.info(`Trying sandbox ${stored.sandboxId} from session ${sessionId}`)
      let connected: { sandboxId: string } | undefined
      try {
        const info = await this.client.getSandbox(stored.sandboxId)
        // 'timeout' is terminal like 'terminated' — waiting on it never ends in 'running'
        if (info.status === 'terminated' || info.status === 'timeout') {
          this.removeSession(projectId, sessionId)
        } else {
          if (info.status === 'suspended' || info.status === 'suspending') {
            logger.info(`Resuming sandbox ${stored.sandboxId} (was ${info.status})`)
            if (info.status === 'suspending') await this.client.waitForSuspended(stored.sandboxId)
            // resumeSandbox blocks until the sandbox is running again
            await this.client.resumeSandbox(stored.sandboxId)
          } else if (info.status !== 'running') {
            await this.client.waitForRunning(stored.sandboxId)
          }
          connected = { sandboxId: stored.sandboxId }
          this.cache.set(sessionId, connected)
          this.updateSession(projectId, worktree, sessionId, stored.sandboxId)
          toast.show({ title: 'Sandbox connected', message: 'Connected to existing sandbox.', variant: 'info' })
        }
      } catch (err) {
        logger.warn(`Failed to connect to sandbox ${stored.sandboxId}: ${err}`)
        this.removeSession(projectId, sessionId)
      }
      // Outside the try: a preparation failure (transient mount or filesystem
      // error) must not drop the mapping. The sandbox is healthy; the next
      // call retries prepareSandbox against the same sandbox.
      if (connected) {
        await this.prepareSandbox(connected.sandboxId)
        this.refreshGitCredentialIfStale(connected.sandboxId)
        return connected
      }
    }

    // Create new sandbox. The configured filesystem is attached at create
    // time (Sandbox.create fileSystems); prepareSandbox below still waits for
    // the guest to materialize the mount before the first tool runs in it.
    logger.info(`Creating new sandbox for session ${sessionId}`)
    if (this.fsMount) {
      // Sandbox.create with an unknown filesystem fails with a bare
      // FileSystemNotFound; check the name first so the user gets the same
      // clear error the reconnect path gives.
      try {
        await assertFileSystemExists(this.client.getApiKey(), this.fsMount.fileSystemId)
      } catch (err: any) {
        logger.error(`Filesystem attach failed: ${err?.message ?? err}`)
        toast.show({ title: 'Filesystem attach failed', message: `${err?.message ?? err}`, variant: 'error' })
        throw err
      }
    }
    const createStart = Date.now()
    const image = process.env.TENSORLAKE_IMAGE
    const sandboxName = `opencode-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
    const created = await this.client.createSandbox({
      ...(image ? { image } : {}),
      name: sandboxName,
      ...(this.fsMount ? { fileSystems: [this.fsMount] } : {}),
    })
    logger.info(`Sandbox created ${created.sandbox_id} in ${Date.now() - createStart}ms`)

    const entry = { sandboxId: created.sandbox_id }
    this.cache.set(sessionId, entry)
    this.updateSession(projectId, worktree, sessionId, created.sandbox_id)

    toast.show({ title: 'Sandbox created', message: 'New sandbox is ready.', variant: 'success' })
    await this.prepareSandbox(created.sandbox_id)
    return entry
  }

  /**
   * Register background work so shutdown can wait for it. Returns the same
   * promise, so callers keep their own error handling; the tracked copy never
   * rejects.
   */
  private track<T>(promise: Promise<T>): Promise<T> {
    const settled: Promise<void> = promise.then(
      () => undefined,
      () => undefined,
    )
    this.pending.add(settled)
    void settled.then(() => this.pending.delete(settled))
    return promise
  }

  /**
   * Whether any tracked background work is still running. Signal handlers use
   * it to keep the old synchronous exit path when there is nothing to drain.
   */
  hasPendingWork(): boolean {
    return this.pending.size > 0
  }

  /**
   * Wait for tracked background work, re-checking after each batch: a delete
   * that was queued behind another task only appears in the set once the
   * first finishes. Gives up (and says so) when the budget runs out rather
   * than holding the exit open forever.
   */
  private async drainPending(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return
    const deadline = Date.now() + timeoutMs
    logger.info(`Shutdown: waiting for ${this.pending.size} pending task(s) to finish`)
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const batch = Promise.all([...this.pending])
      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining)
      })
      const outcome = await Promise.race([batch.then(() => 'done' as const), expiry])
      if (timer) clearTimeout(timer)
      if (outcome === 'timeout') break
    }
    if (this.pending.size > 0) {
      logger.warn(`Shutdown drain timed out; ${this.pending.size} task(s) were abandoned`)
    } else {
      logger.info('Shutdown: pending tasks drained')
    }
  }

  /**
   * Finish (or time out) in-flight sandbox work, then suspend the sandboxes.
   * Called from the signal handlers and from server.instance.disposed; the
   * first call does the work and every later one joins it.
   */
  shutdown(reason: string, opts: { drainMs?: number } = {}): Promise<void> {
    if (this.shutdownRun) return this.shutdownRun
    this.shuttingDown = true
    const drainMs = opts.drainMs ?? TensorlakeSessionManager.drainBudgetMs()
    this.shutdownRun = (async () => {
      logger.info(`Shutdown (${reason}): draining background work before suspend`)
      try {
        await this.drainPending(drainMs)
      } catch (err) {
        logger.warn(`Shutdown drain failed: ${err}`)
      }
      this.suspendAllSandboxes()
    })()
    return this.shutdownRun
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

  /**
   * beginToolCall for a tool call made by any session in a tree: the lease is
   * held against the session that owns the sandbox, so deleting the parent
   * waits for a subagent's tool call that is still writing inside it.
   */
  async leaseToolCall(sessionId: string, pluginCtx?: PluginInput): Promise<() => void> {
    const owner = await this.sessions.root(sessionId, pluginCtx)
    return this.beginToolCall(owner)
  }

  /**
   * Register a running tool execution so deletion can wait for it. Returns the
   * release function; call it in a `finally`.
   */
  beginToolCall(sessionId: string): () => void {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let running = this.activeTools.get(sessionId)
    if (!running) {
      running = new Set()
      this.activeTools.set(sessionId, running)
    }
    running.add(barrier)
    let released = false
    return () => {
      if (released) return
      released = true
      running!.delete(barrier)
      if (running!.size === 0 && this.activeTools.get(sessionId) === running) {
        this.activeTools.delete(sessionId)
      }
      release()
    }
  }

  /**
   * Wait for the session's running tool calls, re-checking after each batch.
   * The bound is on idle time, not total time: one tool call can chain many
   * bounded sandbox operations (apply_patch reads, writes, probes, commits),
   * so the wait continues for as long as the sandbox shows activity and gives
   * up only after `idleMs` with none — a lease whose release leaked must not
   * hold the deletion open forever.
   */
  private async waitForActiveTools(sessionId: string, sandboxId: string | undefined, idleMs: number): Promise<void> {
    const start = Date.now()
    let waited = false
    while (true) {
      const running = this.activeTools.get(sessionId)
      if (!running || running.size === 0) break
      const lastActivity = Math.max(
        start,
        (sandboxId ? this.client.lastActivityAt(sandboxId) : undefined) ?? 0,
      )
      const remaining = lastActivity + idleMs - Date.now()
      if (remaining <= 0) break
      if (!waited) {
        waited = true
        logger.info(`Delete: waiting for ${running.size} running tool call(s) in session ${sessionId}`)
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining)
      })
      // On expiry the loop re-checks: new sandbox activity extends the wait.
      await Promise.race([Promise.all([...running]).then(() => 'done' as const), expiry])
      if (timer) clearTimeout(timer)
    }
    const left = this.activeTools.get(sessionId)?.size ?? 0
    if (left > 0) {
      logger.warn(`Delete: ${left} tool call(s) in session ${sessionId} showed no sandbox activity for ${idleMs}ms; proceeding`)
    }
  }

  /**
   * Delete the session's sandbox. Deduplicated per session: a second call
   * joins the first run rather than racing it through the same teardown.
   *
   * Deleting a subagent session tears nothing down — the sandbox belongs to
   * the session that spawned it, which is very likely still using it.
   */
  deleteSandbox(sessionId: string, projectId: string): Promise<DeleteOutcome> {
    // Cache-only: OpenCode has already dropped the session, so a lookup would
    // 404. The link was recorded when the session was created or deleted.
    const owner = this.sessions.rootCached(sessionId)
    this.sessions.forget(sessionId)
    if (owner !== sessionId) {
      logger.info(`Session ${sessionId} is a subagent of ${owner}; its sandbox stays with the parent session`)
      return Promise.resolve('detached')
    }
    const existing = this.deleteInflight.get(sessionId)
    if (existing) return existing
    const run = this._deleteSandbox(sessionId, projectId).finally(() => this.deleteInflight.delete(sessionId))
    this.deleteInflight.set(sessionId, run)
    return this.track(run)
  }

  private async _deleteSandbox(sessionId: string, projectId: string): Promise<DeleteOutcome> {
    // Block new tool calls from resurrecting the session first, then wait for
    // an in-flight getSandbox: a delete that raced sandbox creation would
    // otherwise see no sandboxId, report success, and orphan the new sandbox.
    this.deleting.add(sessionId)
    const inflight = this.inflight.get(sessionId)
    if (inflight) await inflight.catch(() => undefined)
    // Tool calls that started before the tombstone are still writing inside
    // the sandbox; let them finish so nothing is terminated mid-write. The
    // sandbox id is resolved up front so the wait can watch its activity.
    const knownSandboxId =
      this.cache.get(sessionId)?.sandboxId ?? this.store.read(projectId)?.sessions[sessionId]?.sandboxId
    await this.waitForActiveTools(sessionId, knownSandboxId, TensorlakeSessionManager.DELETE_TOOL_IDLE_MS)

    const cached = this.cache.get(sessionId)
    const projectData = this.store.read(projectId)
    const stored = projectData?.sessions[sessionId]
    const sandboxId = cached?.sandboxId ?? stored?.sandboxId

    if (!sandboxId) {
      logger.info(`No sandbox found for session ${sessionId}; nothing to delete`)
      return 'none'
    }

    // Data persisted before sessions were isolated can alias one sandbox to
    // several sessions. Only tear down the sandbox when no other session
    // still references it; otherwise just detach this session.
    const sharedWith = Object.entries(projectData?.sessions ?? {}).filter(
      ([id, s]) => id !== sessionId && s.sandboxId === sandboxId,
    )
    if (sharedWith.length > 0) {
      this.cache.delete(sessionId)
      this.removeSession(projectId, sessionId)
      logger.warn(`Sandbox ${sandboxId} is still used by ${sharedWith.length} other session(s); detached session ${sessionId} without deleting it`)
      return 'detached'
    }

    logger.info(`Deleting sandbox ${sandboxId} for session ${sessionId}`)
    // Forget the session only after the sandbox is really gone. deleteSandbox
    // treats not-found as success, so a throw here means the sandbox may still
    // be running — dropping the mapping would leave it orphaned and unfindable.
    await this.client.deleteSandbox(sandboxId)
    logger.info(`Sandbox ${sandboxId} deleted`)

    this.cache.delete(sessionId)
    this.removeSession(projectId, sessionId)

    // Drop per-sandbox state — the id never comes back.
    this.prepared.delete(sandboxId)
    this.credRefreshedAt.delete(sandboxId)
    return 'deleted'
  }
}
