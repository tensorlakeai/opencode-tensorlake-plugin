import { RemoteAPIError, Sandbox, SandboxConnectionError, SandboxNotFoundError } from 'tensorlake'
import { execFileSync } from 'child_process'
import { PROJECT_KEY_PREFIX } from './credentials.js'
import { logger } from './logger.js'

const MANAGEMENT_API = process.env.TENSORLAKE_API_URL ?? 'https://api.tensorlake.ai'

export type SandboxInfo = {
  sandbox_id: string
  status: string
}

export type CreateSandboxResponse = {
  sandbox_id: string
  status: string
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
  promise: Promise<Sandbox>
  // Set once the connect resolves; lets dropHandle identity-check an eviction
  // without awaiting the promise.
  sandbox?: Sandbox
}

export class TensorLakeClient {
  // Connected handles keyed by sandboxId, so repeated operations reuse the
  // resolved proxy routing instead of re-resolving on every call. The pending
  // connect promise is cached (not the resolved handle) so concurrent calls
  // share one connect instead of racing and orphaning the loser's handle.
  // Each entry records the API key it was connected with: handles capture the
  // bearer token at connect time, so a handle made with a previous key must be
  // replaced when `opencode auth login` stores a new one — even if the old
  // key is still valid and would never produce a 401.
  private readonly handles = new Map<string, HandleEntry>()

  // Credentials are resolved lazily on every use so a key added via
  // `opencode auth login` after startup is picked up without a restart.
  constructor(private readonly resolveKey: () => string | undefined) {}

  hasApiKey(): boolean {
    return (this.resolveKey() ?? '').length > 0
  }

  getApiKey(): string {
    return this.resolveKey() ?? ''
  }

  private warnedProjectKeyScopeOverride = false

  private clientOptions() {
    const apiKey = this.getApiKey()
    const organizationId = process.env.TENSORLAKE_ORGANIZATION_ID
    const projectId = process.env.TENSORLAKE_PROJECT_ID
    // A project API key carries its own org/project scope. Forwarding env IDs
    // alongside it could point requests at a different project than the key
    // authorizes, so the key's scope wins and the variables are ignored.
    if (apiKey.startsWith(PROJECT_KEY_PREFIX) && (organizationId || projectId)) {
      if (!this.warnedProjectKeyScopeOverride) {
        this.warnedProjectKeyScopeOverride = true
        logger.warn(
          'TENSORLAKE_ORGANIZATION_ID/TENSORLAKE_PROJECT_ID are set, but the API key is a project key ' +
            `(${PROJECT_KEY_PREFIX}...) that carries its own scope; ignoring the environment variables.`,
        )
      }
      return { apiKey, apiUrl: MANAGEMENT_API }
    }
    return {
      apiKey,
      apiUrl: MANAGEMENT_API,
      ...(organizationId ? { organizationId } : {}),
      ...(projectId ? { projectId } : {}),
    }
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
    const sandbox = await this.connectSandbox(sandboxId)
    try {
      return await op(sandbox)
    } catch (err: unknown) {
      if (!this.isStaleHandleError(err)) throw err
      this.dropHandle(sandboxId, sandbox)
      if (!opts.retry) throw err
      logger.warn(`Sandbox ${sandboxId} call failed (${(err as Error)?.message ?? err}); reconnecting and retrying once`)
      return op(await this.connectSandbox(sandboxId))
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

  async createSandbox(opts: { image?: string; name?: string; timeoutSecs?: number } = {}): Promise<CreateSandboxResponse> {
    const cpus = parseFloat(process.env.TENSORLAKE_CPUS ?? '2')
    const memoryMb = parseInt(process.env.TENSORLAKE_MEMORY_MB ?? '4096', 10)
    const ephemeralDiskMb = parseInt(process.env.TENSORLAKE_DISK_MB ?? '10240', 10)
    logger.info(`Creating sandbox name=${opts.name ?? '(ephemeral)'} image=${opts.image ?? '(default)'} cpus=${cpus} memoryMb=${memoryMb} diskMb=${ephemeralDiskMb}`)
    const proxyUrl = process.env.TENSORLAKE_SANDBOX_PROXY_URL
    const sandbox = await Sandbox.create({
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(opts.image ? { image: opts.image } : {}),
      cpus,
      memoryMb,
      diskMb: ephemeralDiskMb,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.timeoutSecs ? { timeoutSecs: opts.timeoutSecs } : {}),
      ...this.clientOptions(),
    })
    this.handles.set(sandbox.sandboxId, { apiKey: this.getApiKey(), promise: Promise.resolve(sandbox), sandbox })
    return { sandbox_id: sandbox.sandboxId, status: 'running' }
  }

  async getSandbox(sandboxId: string): Promise<SandboxInfo> {
    const info = await this.withSandbox(sandboxId, (sandbox) => sandbox.info())
    return { sandbox_id: info.sandboxId, status: info.status as unknown as string }
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    try {
      // Route through withSandbox so a stale handle (revoked key, dead proxy
      // routing) is dropped and terminate() retried once on a fresh
      // connection. terminate() is safe to retry: a second attempt against an
      // already-terminated sandbox surfaces as not-found, handled below.
      await this.withSandbox(sandboxId, (sandbox) => sandbox.terminate())
    } catch (err: unknown) {
      // Already deleted — treat as success.
      if (err instanceof SandboxNotFoundError) return
      if (err instanceof RemoteAPIError && err.statusCode === 404) return
      // The SDK passes the original untyped Error through when a native error
      // payload does not parse, so a not-found can also arrive as a plain
      // Error mentioning 404.
      if (String((err as Error)?.message ?? err).includes('404')) return
      throw err
    } finally {
      this.dropHandle(sandboxId)
    }
  }

  async suspendSandbox(sandboxId: string): Promise<void> {
    await this.withSandbox(sandboxId, (sandbox) => sandbox.suspend())
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

  async resumeSandbox(sandboxId: string): Promise<void> {
    // resume() waits for running and refreshes the handle's proxy routing.
    await this.withSandbox(sandboxId, (sandbox) => sandbox.resume())
  }

  async waitForSuspended(sandboxId: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const info = await this.getSandbox(sandboxId)
      if (info.status === 'suspended' || info.status === 'terminated') return
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  async waitForRunning(sandboxId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const info = await this.getSandbox(sandboxId)
      if (info.status === 'running') return
      if (info.status === 'terminated') throw new Error(`Sandbox ${sandboxId} was terminated`)
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`Sandbox ${sandboxId} did not become running within ${timeoutMs}ms`)
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    workingDir = '/tmp/workspace',
    timeoutMs = 120_000,
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
