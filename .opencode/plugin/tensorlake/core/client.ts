import { SandboxClient } from 'tensorlake'
import type { Sandbox } from 'tensorlake'
import { execFileSync } from 'child_process'
import { logger } from './logger.js'

const MANAGEMENT_API = process.env.TENSORLAKE_API_URL ?? 'https://api.tensorlake.ai'

function getSandboxProxyUrl(sandboxId: string): string {
  const custom = process.env.TENSORLAKE_SANDBOX_PROXY_URL
  if (custom) return custom
  return `https://${sandboxId}.sandbox.tensorlake.ai`
}

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

export class TensorLakeClient {
  private readonly sdk: SandboxClient

  constructor(private readonly apiKey: string) {
    this.sdk = SandboxClient.forCloud({
      apiKey,
      apiUrl: MANAGEMENT_API,
      organizationId: process.env.TENSORLAKE_ORGANIZATION_ID,
      projectId: process.env.TENSORLAKE_PROJECT_ID,
    })
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0
  }

  async createSandbox(opts: { image?: string; name?: string; timeoutSecs?: number } = {}): Promise<CreateSandboxResponse> {
    const cpus = parseFloat(process.env.TENSORLAKE_CPUS ?? '2')
    const memoryMb = parseInt(process.env.TENSORLAKE_MEMORY_MB ?? '4096', 10)
    const ephemeralDiskMb = parseInt(process.env.TENSORLAKE_DISK_MB ?? '10240', 10)
    logger.info(`Creating sandbox name=${opts.name ?? '(ephemeral)'} image=${opts.image ?? '(default)'} cpus=${cpus} memoryMb=${memoryMb} diskMb=${ephemeralDiskMb}`)
    const sandbox = await this.sdk.createAndConnect({
      ...(opts.image ? { image: opts.image } : {}),
      cpus,
      memoryMb,
      diskMb: ephemeralDiskMb,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.timeoutSecs ? { timeoutSecs: opts.timeoutSecs } : {}),
    })
    return { sandbox_id: sandbox.sandboxId, status: 'running' }
  }

  async getSandbox(sandboxId: string): Promise<SandboxInfo> {
    const info = await this.sdk.get(sandboxId)
    return { sandbox_id: info.sandboxId, status: info.status as unknown as string }
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    try {
      await this.sdk.delete(sandboxId)
    } catch (err: unknown) {
      if (String((err as Error)?.message ?? err).includes('404')) return
      throw err
    }
  }

  async suspendSandbox(sandboxId: string): Promise<void> {
    await this.sdk.suspend(sandboxId)
  }

  suspendSandboxSync(sandboxId: string): void {
    execFileSync('curl', [
      '-s', '-X', 'POST',
      `${MANAGEMENT_API}/sandboxes/${sandboxId}/suspend`,
      '-H', `Authorization: Bearer ${this.apiKey}`,
    ], { timeout: 10_000 })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const out = execFileSync('curl', [
          '-s',
          `${MANAGEMENT_API}/sandboxes/${sandboxId}`,
          '-H', `Authorization: Bearer ${this.apiKey}`,
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
    await this.sdk.resume(sandboxId)
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

  private connectSandbox(sandboxId: string): Sandbox {
    return this.sdk.connect(sandboxId, getSandboxProxyUrl(sandboxId))
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    workingDir = '/tmp/workspace',
    timeoutMs = 120_000,
  ): Promise<ProcessResult> {
    const sandbox = this.connectSandbox(sandboxId)
    const result = await sandbox.run('sh', {
      args: ['-c', command],
      workingDir,
      timeout: timeoutMs / 1000,
    })
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
    const sandbox = this.connectSandbox(sandboxId)
    const data = await sandbox.readFile(path)
    return Buffer.from(data)
  }

  async writeFile(sandboxId: string, path: string, content: Buffer): Promise<void> {
    const sandbox = this.connectSandbox(sandboxId)
    await sandbox.writeFile(path, content)
  }

  async listDirectory(sandboxId: string, path: string): Promise<DirectoryEntry[]> {
    const sandbox = this.connectSandbox(sandboxId)
    const response = await sandbox.listDirectory(path)
    return response.entries.map((e) => ({
      name: e.name,
      is_dir: e.isDir,
      size: e.size,
    }))
  }
}
