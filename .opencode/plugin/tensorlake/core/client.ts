import { RemoteAPIError, Sandbox, SandboxConnectionError, SandboxNotFoundError } from 'tensorlake'
import type { FileSystemMount, GetOrCreateOutcome } from 'tensorlake'
import { execFileSync } from 'child_process'
import { logger } from './logger.js'
import { shellQuote } from './shell.js'

const MANAGEMENT_API = process.env.TENSORLAKE_API_URL ?? 'https://api.tensorlake.ai'

/** Default bound on one sandbox command. Waits that must outlast a running
 * tool call (e.g. deletion draining active leases) size themselves off this. */
export const COMMAND_TIMEOUT_MS = 120_000

/** What getOrCreateSandbox reports about the sandbox bound to a name. */
export type BoundSandbox = {
  sandboxId: string
  /** What the bind did: created a sandbox, attached to a running one, or resumed a suspended one. */
  outcome: GetOrCreateOutcome
}

export type ProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type DirectoryEntry = {
  name: string
  is_dir: boolean
  size?: number
}

type HandleEntry = {
  apiKey: string
  // Fingerprint of the proxy routing the handle was stored with (see
  // routingFingerprint). A resume can move the sandbox to another host;
  // getOrCreateSandbox compares this to decide whether a fresh handle must
  // replace it. Unset for a handle from connectSandbox (routing unknown), so
  // the next getOrCreateSandbox replaces that handle with one it can vouch for.
  routing?: string
  promise: Promise<Sandbox>
  // Set once the connect resolves; lets dropHandle identity-check an eviction
  // without awaiting the promise.
  sandbox?: Sandbox
}

// Every field the SDK feeds into proxy selection (sandboxUrl, ingressEndpoint)
// and request routing (routingHint). A change in any one of them means the
// cached handle points at the wrong place, so none may mask another.
function routingFingerprint(info: { sandboxUrl?: string; ingressEndpoint?: string; routingHint?: string }): string {
  return JSON.stringify([info.sandboxUrl ?? null, info.ingressEndpoint ?? null, info.routingHint ?? null])
}

export class TensorlakeClient {
  // Connected handles keyed by sandboxId, so repeated operations reuse the
  // resolved proxy routing instead of re-resolving on every call. The pending
  // connect promise is cached (not the resolved handle) so concurrent calls
  // share one connect instead of racing and orphaning the loser's handle.
  // Each entry records the API key it was connected with: handles capture the
  // bearer token at connect time, so a handle made with a previous key must be
  // replaced when `opencode auth login` stores a new one — even if the old
  // key is still valid and would never produce a 401.
  private readonly handles = new Map<string, HandleEntry>()

  // When each sandbox last started or settled a proxy-routed operation.
  // Deletion watches this to tell a tool call that is still making progress
  // (a chain of bounded ops) from a lease whose release leaked.
  private readonly activityAt = new Map<string, number>()

  private touch(sandboxId: string): void {
    this.activityAt.set(sandboxId, Date.now())
  }

  /** When the sandbox last started or settled an operation, if ever. */
  lastActivityAt(sandboxId: string): number | undefined {
    return this.activityAt.get(sandboxId)
  }

  // Credentials are resolved lazily on every use so a key added via
  // `opencode auth login` after startup is picked up without a restart.
  constructor(private readonly resolveKey: () => string | undefined) {}

  hasApiKey(): boolean {
    return (this.resolveKey() ?? '').length > 0
  }

  getApiKey(): string {
    return this.resolveKey() ?? ''
  }

  // Ingress derives the organization/project scope from the API key itself
  // (SDK >= 0.5.114); explicit scope options are no longer forwarded.
  private clientOptions() {
    return { apiKey: this.getApiKey(), apiUrl: MANAGEMENT_API }
  }

  private connectSandbox(sandboxId: string): Promise<Sandbox> {
    const apiKey = this.getApiKey()
    const cached = this.handles.get(sandboxId)
    if (cached) {
      if (cached.apiKey === apiKey) return cached.promise
      this.dropHandle(sandboxId)
    }
    const proxyUrl = process.env.TENSORLAKE_SANDBOX_PROXY_URL
    const entry: HandleEntry = {
      apiKey,
      promise: Sandbox.connect({
        sandboxId,
        ...(proxyUrl ? { proxyUrl } : {}),
        ...this.clientOptions(),
      }),
    }
    entry.promise = entry.promise.then(
      (sandbox) => {
        entry.sandbox = sandbox
        return sandbox
      },
      (err: unknown) => {
        if (this.handles.get(sandboxId) === entry) this.handles.delete(sandboxId)
        throw err
      },
    )
    this.handles.set(sandboxId, entry)
    return entry.promise
  }

  // Errors suggesting the cached handle is unusable — stale proxy routing
  // (e.g. the sandbox was suspended and resumed outside this process, moving
  // it to a different host) or stale credentials (401/403 after a key
  // rotation; handles capture the key at connect time, so only a reconnect
  // picks up the new one). Plain 404 is excluded on purpose: sandbox-level
  // not-found already arrives as SandboxNotFoundError, so a bare 404 is a
  // daemon endpoint's normal answer (missing file, unknown pid) and must not
  // tear down a healthy handle.
  private isStaleHandleError(err: unknown): boolean {
    return (
      err instanceof SandboxConnectionError ||
      err instanceof SandboxNotFoundError ||
      (err instanceof RemoteAPIError && [401, 403, 502, 503].includes(err.statusCode))
    )
  }

  // Runs a proxy-routed operation. On a stale-handle error the handle is
  // dropped so the next call reconnects with fresh routing; idempotent ops
  // (retry: true) additionally reconnect and retry once themselves. Command
  // execution uses retry: false to avoid any chance of running a command twice.
  private async withSandbox<T>(
    sandboxId: string,
    op: (sandbox: Sandbox) => Promise<T>,
    opts: { retry: boolean } = { retry: true },
  ): Promise<T> {
    this.touch(sandboxId)
    try {
      const sandbox = await this.connectSandbox(sandboxId)
      try {
        return await op(sandbox)
      } catch (err: unknown) {
        if (!this.isStaleHandleError(err)) throw err
        this.dropHandle(sandboxId, sandbox)
        if (!opts.retry) throw err
        logger.warn(`Sandbox ${sandboxId} call failed (${(err as Error)?.message ?? err}); reconnecting and retrying once`)
        return await op(await this.connectSandbox(sandboxId))
      }
    } finally {
      this.touch(sandboxId)
    }
  }

  // When `sandbox` is given, the entry is evicted only if it still holds that
  // same handle — a late failure from an old handle must not tear down a
  // fresh one another call has stored (or is still connecting) since.
  private dropHandle(sandboxId: string, sandbox?: Sandbox): void {
    const entry = this.handles.get(sandboxId)
    if (!entry) return
    if (sandbox && entry.sandbox !== sandbox) return
    this.handles.delete(sandboxId)
    entry.promise
      .then((s) => s.close())
      .catch(() => {
        // closing a stale handle is best-effort
      })
  }

  /**
   * The one sandbox bound to `name`, running. Sandbox.getOrCreate does all
   * the lifecycle work: it attaches to the sandbox holding the name, creates
   * it when nothing does, waits for a sandbox another caller is still
   * starting, and resumes a suspended one. The create options apply only
   * when it creates.
   *
   * Handle caching: the new handle carries fresh proxy routing. It replaces
   * the cached handle only when that routing changed or no handle is cached;
   * otherwise it is closed and the cached handle stays, so tool calls already
   * running on it are not cut off. The routing comes from `info()`, not from
   * `bindOutcome`: a suspend and resume done outside this process moves the
   * sandbox, yet this process then sees `attached`, not `resumed`.
   */
  async getOrCreateSandbox(
    name: string,
    opts: { image?: string; fileSystems?: FileSystemMount[] } = {},
  ): Promise<BoundSandbox> {
    const cpus = parseFloat(process.env.TENSORLAKE_CPUS ?? '2')
    const memoryMb = parseInt(process.env.TENSORLAKE_MEMORY_MB ?? '4096', 10)
    const diskMb = parseInt(process.env.TENSORLAKE_DISK_MB ?? '10240', 10)
    const proxyUrl = process.env.TENSORLAKE_SANDBOX_PROXY_URL
    const apiKey = this.getApiKey()
    const sandbox = await Sandbox.getOrCreate(name, {
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(opts.image ? { image: opts.image } : {}),
      cpus,
      memoryMb,
      diskMb,
      ...(opts.fileSystems?.length ? { fileSystems: opts.fileSystems } : {}),
      ...this.clientOptions(),
    })
    const sandboxId = sandbox.sandboxId
    const outcome = sandbox.bindOutcome ?? 'attached'
    const info = await sandbox.info()
    const routing = routingFingerprint(info)
    const cached = this.handles.get(sandboxId)
    if (cached && cached.apiKey === apiKey && cached.routing === routing) {
      void Promise.resolve(sandbox.close()).catch(() => {
        // closing the surplus handle is best-effort
      })
    } else {
      this.dropHandle(sandboxId)
      this.handles.set(sandboxId, { apiKey, routing, promise: Promise.resolve(sandbox), sandbox })
    }
    return { sandboxId, outcome }
  }

  async listSandboxFileSystems(sandboxId: string): Promise<FileSystemMount[]> {
    const info = await this.withSandbox(sandboxId, (sandbox) => sandbox.info())
    return info.fileSystems ?? []
  }

  async attachFileSystem(sandboxId: string, fileSystemId: string, mountPath: string): Promise<void> {
    // retry: false — a retried attach after a mid-flight failure could double-attach
    await this.withSandbox(sandboxId, (sandbox) => sandbox.attachFileSystem(fileSystemId, mountPath), { retry: false })
  }

  async detachFileSystem(sandboxId: string, mountPath: string): Promise<void> {
    // retry: false — a retry after a mid-flight success would fail on the
    // already-detached path and mask the real outcome
    await this.withSandbox(sandboxId, (sandbox) => sandbox.detachFileSystem(mountPath), { retry: false })
  }

  /**
   * Terminate a sandbox, by id or by name. Returns false when nothing held
   * that identifier (already deleted), true when a sandbox was terminated.
   */
  async deleteSandbox(sandboxId: string): Promise<boolean> {
    try {
      // Route through withSandbox so a stale handle (revoked key, dead proxy
      // routing) is dropped and terminate() retried once on a fresh
      // connection. terminate() is safe to retry: a second attempt against an
      // already-terminated sandbox surfaces as not-found, handled below.
      await this.withSandbox(sandboxId, (sandbox) => sandbox.terminate())
      return true
    } catch (err: unknown) {
      // Already deleted — treat as success.
      if (err instanceof SandboxNotFoundError) return false
      if (err instanceof RemoteAPIError && err.statusCode === 404) return false
      // The SDK passes the original untyped Error through when a native error
      // payload does not parse, so a not-found can also arrive as a plain
      // Error mentioning 404.
      if (String((err as Error)?.message ?? err).includes('404')) return false
      throw err
    } finally {
      this.forgetSandbox(sandboxId)
    }
  }

  /** Drop the cached handle and activity record of a sandbox that is gone. */
  forgetSandbox(sandboxId: string): void {
    this.dropHandle(sandboxId)
    this.activityAt.delete(sandboxId)
  }

  suspendSandboxSync(sandboxId: string): void {
    const apiKey = this.getApiKey()
    execFileSync('curl', [
      '-s', '-X', 'POST',
      `${MANAGEMENT_API}/sandboxes/${sandboxId}/suspend`,
      '-H', `Authorization: Bearer ${apiKey}`,
    ], { timeout: 10_000 })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const out = execFileSync('curl', [
          '-s',
          `${MANAGEMENT_API}/sandboxes/${sandboxId}`,
          '-H', `Authorization: Bearer ${apiKey}`,
        ], { timeout: 10_000 }).toString()
        const status = JSON.parse(out)?.status
        if (status === 'suspended' || status === 'terminated') return
      } catch {
        return
      }
      execFileSync('sleep', ['0.5'])
    }
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    workingDir = '/tmp/workspace',
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<ProcessResult> {
    const result = await this.withSandbox(
      sandboxId,
      (sandbox) =>
        sandbox.run('sh', {
          args: ['-c', command],
          workingDir,
          timeout: timeoutMs / 1000,
        }),
      { retry: false },
    )
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
    const data = await this.withSandbox(sandboxId, (sandbox) => sandbox.readFile(path))
    return Buffer.from(data)
  }

  /**
   * Reads a whole file, but checks its size in the sandbox first. Editing tools
   * need the complete text, so the only protection against a huge or binary
   * file exhausting this process is to refuse it before the transfer starts.
   */
  async readFileBounded(sandboxId: string, path: string, maxBytes: number): Promise<Buffer> {
    const probe = await this.executeCommand(sandboxId, `wc -c < ${shellQuote(path)} 2>/dev/null`, '/', 15_000)
    const size = Number(probe.stdout.trim())
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(
        `${path} is ${size} bytes, over the ${maxBytes}-byte edit limit. ` +
          'Use the read tool with offset and limit, or edit it with a bash command.',
      )
    }
    return this.readFile(sandboxId, path)
  }

  async writeFile(sandboxId: string, path: string, content: Buffer): Promise<void> {
    await this.withSandbox(sandboxId, (sandbox) => sandbox.writeFile(path, content))
  }

  async listDirectory(sandboxId: string, path: string): Promise<DirectoryEntry[]> {
    const response = await this.withSandbox(sandboxId, (sandbox) => sandbox.listDirectory(path))
    return response.entries.map((e) => ({
      name: e.name,
      is_dir: e.isDir,
      size: e.size,
    }))
  }
}
