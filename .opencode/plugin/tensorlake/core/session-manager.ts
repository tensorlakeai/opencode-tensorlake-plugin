import { RemoteAPIError } from 'tensorlake'
import type { FileSystemMount } from 'tensorlake'
import { COMMAND_TIMEOUT_MS, TensorlakeClient } from './client.js'
import { LOGIN_HINT, projectKeyWarning } from './credentials.js'
import { logger } from './logger.js'
import { toast } from './toast.js'
import { SessionTree } from './session-tree.js'
import { resolveFileSystemMount, ensureFileSystemMounted, assertFileSystemExists } from './filesystem.js'
import { resolveGitRepo, bootstrapSandboxGit, GIT_CREDENTIAL_REFRESH_MS } from './git-bootstrap.js'
import type { PluginInput } from '@opencode-ai/plugin'

/**
 * What a delete request did. Only 'deleted' really tore a sandbox down — a
 * subagent session is just detached, and a session that never had a sandbox
 * does nothing at all.
 */
export type DeleteOutcome = 'deleted' | 'detached' | 'none'

/**
 * The sandbox name for a session. This name is the whole session-to-sandbox
 * binding: Sandbox.getOrCreate finds the sandbox by it from any process or
 * machine, so nothing needs to be stored locally. Deterministic, so every
 * call for one session lands on the same sandbox; a session id is globally
 * unique, so no two sessions share a name.
 */
export function sandboxName(sessionId: string): string {
  return `opencode-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
}

export class TensorlakeSessionManager {
  private readonly client: TensorlakeClient
  // Sandboxes bound in this process: sessionId -> sandboxId. Used to suspend
  // them at exit and to skip the "sandbox ready" toast on later tool calls.
  private readonly cache = new Map<string, { sandboxId: string }>()
  // In-flight getSandbox promises keyed by sessionId — concurrent tool calls
  // share one bind instead of each racing Sandbox.getOrCreate
  private readonly inflight = new Map<string, Promise<{ sandboxId: string }>>()
  // Sandboxes whose workspace preparation (workdir, filesystem, git) ran in this process
  private readonly prepared = new Set<string>()
  // In-flight preparation per sandbox — concurrent tool calls share one run
  private readonly prepareInflight = new Map<string, Promise<void>>()
  // Keys already checked for project scope — the warning fires once per key
  private readonly warnedKeys = new Set<string>()
  // Filesystem names confirmed to exist, per API key — checked once per process
  private readonly checkedFileSystems = new Set<string>()
  // Session -> the session that owns its sandbox. Subagent sessions share
  // their parent's sandbox instead of each getting their own workspace;
  // see SessionTree.
  private readonly sessions = new SessionTree()
  // Sessions whose sandbox was (or is being) deleted — a late tool call must
  // fail instead of getOrCreate silently binding a fresh sandbox to a dead
  // session
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
  // Configured Tensorlake filesystem to attach to every sandbox (optional)
  private fsMount: FileSystemMount | undefined
  // Configured Tensorlake-hosted git repository to bootstrap (optional)
  private gitRepo: string | undefined

  constructor(resolveKey: () => string | undefined, workDir: string) {
    this.client = new TensorlakeClient(resolveKey)
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
   * configured, the plain workspace directory otherwise.
   */
  projectDir(): string {
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

  /**
   * The sandbox for a session. A subagent session is served the sandbox of the
   * session that spawned it, so the whole tree shares one workspace.
   */
  async getSandbox(sessionId: string, pluginCtx?: PluginInput): Promise<{ sandboxId: string }> {
    const owner = await this.sessions.root(sessionId, pluginCtx)
    if (owner !== sessionId && !this.sharedLogged.has(sessionId)) {
      this.sharedLogged.add(sessionId)
      logger.info(`Session ${sessionId} is a subagent of ${owner}; routing its tool calls to the parent's sandbox`)
    }
    return this.getOwnerSandbox(owner, pluginCtx)
  }

  /** getSandbox for a session id already resolved to its sandbox owner. */
  private getOwnerSandbox(sessionId: string, pluginCtx?: PluginInput): Promise<{ sandboxId: string }> {
    if (this.deleting.has(sessionId)) {
      return Promise.reject(new Error(`Session ${sessionId} was deleted; its sandbox is gone and will not be recreated.`))
    }
    const existing = this.inflight.get(sessionId)
    if (existing) return existing
    const promise = this._getSandbox(sessionId, pluginCtx)
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

  /**
   * Bind the session to its sandbox and make sure it is running. One call
   * to Sandbox.getOrCreate covers every case the session can be in: no
   * sandbox yet (create), a sandbox from an earlier process or machine
   * (attach), a suspended one (resume), one still starting (wait).
   */
  private async _getSandbox(sessionId: string, pluginCtx?: PluginInput): Promise<{ sandboxId: string }> {
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

    // The configured filesystem is attached at create time. Sandbox.create
    // with an unknown filesystem fails with a bare FileSystemNotFound, so the
    // name is confirmed first (once per process) to give the same clear error
    // the attach path gives.
    if (this.fsMount) await this.assertFileSystem(apiKey, this.fsMount.fileSystemId)

    const name = sandboxName(sessionId)
    const image = process.env.TENSORLAKE_IMAGE
    const start = Date.now()
    const bound = await this.client.getOrCreateSandbox(name, {
      ...(image ? { image } : {}),
      ...(this.fsMount ? { fileSystems: [this.fsMount] } : {}),
    })

    const previous = this.cache.get(sessionId)?.sandboxId
    if (previous !== bound.sandboxId) {
      if (previous) {
        // The sandbox this process knew is gone (idle timeout, deleted
        // elsewhere) and the name now binds a new one; its per-sandbox state
        // never comes back.
        logger.warn(`Sandbox ${previous} for session ${sessionId} was replaced by ${bound.sandboxId}`)
        this.prepared.delete(previous)
        this.credRefreshedAt.delete(previous)
      }
      this.cache.set(sessionId, { sandboxId: bound.sandboxId })
    }
    if (previous !== bound.sandboxId || bound.outcome !== 'attached') {
      logger.info(`Sandbox ${bound.sandboxId} (${name}) ${bound.outcome} for session ${sessionId} in ${Date.now() - start}ms`)
    }
    // A revisit of a running sandbox is only announced once per process. A
    // create or resume is always announced: both mean the sandbox was not
    // running a moment ago.
    if (bound.outcome === 'created') {
      toast.show({ title: 'Sandbox created', message: 'New sandbox is ready.', variant: 'success' })
    } else if (bound.outcome === 'resumed') {
      toast.show({ title: 'Sandbox resumed', message: 'Suspended sandbox is running again.', variant: 'info' })
    } else if (previous !== bound.sandboxId) {
      toast.show({ title: 'Sandbox connected', message: 'Connected to existing sandbox.', variant: 'info' })
    }

    // No-op when already prepared; retries a previously failed preparation
    await this.prepareSandbox(bound.sandboxId)
    this.refreshGitCredentialIfStale(bound.sandboxId)
    return { sandboxId: bound.sandboxId }
  }

  private async assertFileSystem(apiKey: string, fileSystemId: string): Promise<void> {
    const key = `${apiKey}\0${fileSystemId}`
    if (this.checkedFileSystems.has(key)) return
    try {
      await assertFileSystemExists(apiKey, fileSystemId)
    } catch (err: any) {
      logger.error(`Filesystem attach failed: ${err?.message ?? err}`)
      toast.show({ title: 'Filesystem attach failed', message: `${err?.message ?? err}`, variant: 'error' })
      throw err
    }
    this.checkedFileSystems.add(key)
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
  deleteSandbox(sessionId: string): Promise<DeleteOutcome> {
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
    const run = this._deleteSandbox(sessionId).finally(() => this.deleteInflight.delete(sessionId))
    this.deleteInflight.set(sessionId, run)
    return this.track(run)
  }

  private async _deleteSandbox(sessionId: string): Promise<DeleteOutcome> {
    // Block new tool calls from resurrecting the session first, then wait for
    // an in-flight getSandbox: a delete that raced sandbox creation would
    // otherwise miss the new sandbox and orphan it.
    this.deleting.add(sessionId)
    const inflight = this.inflight.get(sessionId)
    if (inflight) await inflight.catch(() => undefined)
    // Tool calls that started before the tombstone are still writing inside
    // the sandbox; let them finish so nothing is terminated mid-write.
    const knownSandboxId = this.cache.get(sessionId)?.sandboxId
    await this.waitForActiveTools(sessionId, knownSandboxId, TensorlakeSessionManager.DELETE_TOOL_IDLE_MS)

    // Always delete by name. The name is the binding: it is what a tool
    // call would attach to, from this process or any other. A cached id can
    // be stale (its sandbox timed out and another process bound a new one to
    // the name); deleting by that id would hit a dead sandbox, report
    // nothing to delete, and orphan the live one.
    const name = sandboxName(sessionId)
    logger.info(`Deleting sandbox ${name} for session ${sessionId}`)
    // Forget the session only after the sandbox is really gone. A throw here
    // means the sandbox may still be running; keeping the cache entry lets
    // shutdown still suspend it.
    const existed = await this.client.deleteSandbox(name)
    this.cache.delete(sessionId)
    if (knownSandboxId) {
      // Drop per-sandbox state — the id never comes back.
      this.client.forgetSandbox(knownSandboxId)
      this.prepared.delete(knownSandboxId)
      this.credRefreshedAt.delete(knownSandboxId)
    }
    if (!existed) {
      logger.info(`No sandbox found for session ${sessionId}; nothing to delete`)
      return 'none'
    }
    logger.info(`Sandbox ${name} deleted`)
    return 'deleted'
  }
}
