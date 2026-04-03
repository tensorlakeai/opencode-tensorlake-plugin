import { execFileSync } from 'child_process'
import { logger } from './logger.js'

const MANAGEMENT_API = process.env.TENSORLAKE_API_URL ?? 'https://api.tensorlake.ai'

export function getSandboxProxyUrl(sandboxId: string): string {
  const base = process.env.TENSORLAKE_SANDBOX_PROXY_URL ?? 'https://sandbox.tensorlake.ai'
  // If custom env var is set, use it directly; otherwise construct subdomain URL
  if (process.env.TENSORLAKE_SANDBOX_PROXY_URL) return base
  return `https://${sandboxId}.sandbox.tensorlake.ai`
}

export type SandboxInfo = {
  sandbox_id: string
  status: 'pending' | 'running' | 'snapshotting' | 'suspended' | 'terminated'
  sandbox_url?: string
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
  constructor(private readonly apiKey: string) {}

  hasApiKey(): boolean {
    return this.apiKey.length > 0
  }

  private mgmtHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  private proxyHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  async createSandbox(opts: { image?: string; timeoutSecs?: number } = {}): Promise<CreateSandboxResponse> {
    const cpus = parseInt(process.env.TENSORLAKE_CPUS ?? '2', 10)
    const memory_mb = parseInt(process.env.TENSORLAKE_MEMORY_MB ?? '4096', 10)
    const ephemeral_disk_mb = parseInt(process.env.TENSORLAKE_DISK_MB ?? '10240', 10)
    const body = {
      image: opts.image ?? 'ubuntu:24.04',
      resources: { cpus, memory_mb, ephemeral_disk_mb },
      ...(opts.timeoutSecs ? { timeout_secs: opts.timeoutSecs } : {}),
    }
    logger.info(`Creating sandbox image=${body.image} cpus=${cpus} memory_mb=${memory_mb} disk_mb=${ephemeral_disk_mb}`)
    const res = await fetch(`${MANAGEMENT_API}/sandboxes`, {
      method: 'POST',
      headers: this.mgmtHeaders(),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Failed to create sandbox: ${res.status} ${await res.text()}`)
    return res.json() as Promise<CreateSandboxResponse>
  }

  async getSandbox(sandboxId: string): Promise<SandboxInfo> {
    const res = await fetch(`${MANAGEMENT_API}/sandboxes/${sandboxId}`, {
      headers: this.mgmtHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to get sandbox ${sandboxId}: ${res.status} ${await res.text()}`)
    return res.json() as Promise<SandboxInfo>
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const res = await fetch(`${MANAGEMENT_API}/sandboxes/${sandboxId}`, {
      method: 'DELETE',
      headers: this.mgmtHeaders(),
    })
    if (!res.ok && res.status !== 404) throw new Error(`Failed to delete sandbox: ${res.status} ${await res.text()}`)
  }

  async suspendSandbox(sandboxId: string): Promise<void> {
    const res = await fetch(`${MANAGEMENT_API}/sandboxes/${sandboxId}/suspend`, {
      method: 'POST',
      headers: this.mgmtHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to suspend sandbox: ${res.status} ${await res.text()}`)
  }

  suspendSandboxSync(sandboxId: string): void {
    execFileSync('curl', [
      '-s', '-X', 'POST',
      `${MANAGEMENT_API}/sandboxes/${sandboxId}/suspend`,
      '-H', `Authorization: Bearer ${this.apiKey}`,
    ], { timeout: 10_000 })
  }

  async resumeSandbox(sandboxId: string): Promise<void> {
    const res = await fetch(`${MANAGEMENT_API}/sandboxes/${sandboxId}/resume`, {
      method: 'POST',
      headers: this.mgmtHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to resume sandbox: ${res.status} ${await res.text()}`)
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
    proxyUrl: string,
    command: string,
    workingDir = '/workspace',
    timeoutMs = 120_000,
  ): Promise<ProcessResult> {
    // Start process
    const startRes = await fetch(`${proxyUrl}/api/v1/processes`, {
      method: 'POST',
      headers: { ...this.proxyHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'sh', args: ['-c', command], working_dir: workingDir }),
    })
    if (!startRes.ok) throw new Error(`Failed to start process: ${startRes.status} ${await startRes.text()}`)
    const proc = (await startRes.json()) as { pid: number; status: string }

    // Poll until complete
    const deadline = Date.now() + timeoutMs
    let procInfo: { pid: number; status: string; exit_code?: number } = proc
    while (procInfo.status === 'running') {
      if (Date.now() > deadline) {
        // Kill the process
        await fetch(`${proxyUrl}/api/v1/processes/${proc.pid}/signal`, {
          method: 'POST',
          headers: { ...this.proxyHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ signal: 9 }),
        }).catch(() => {})
        throw new Error(`Command timed out after ${timeoutMs}ms`)
      }
      await new Promise((r) => setTimeout(r, 100))
      const pollRes = await fetch(`${proxyUrl}/api/v1/processes/${proc.pid}`, {
        headers: this.proxyHeaders(),
      })
      if (!pollRes.ok) break
      procInfo = (await pollRes.json()) as { pid: number; status: string; exit_code?: number }
    }

    // Get output
    const [stdoutRes, stderrRes] = await Promise.all([
      fetch(`${proxyUrl}/api/v1/processes/${proc.pid}/stdout`, { headers: this.proxyHeaders() }),
      fetch(`${proxyUrl}/api/v1/processes/${proc.pid}/stderr`, { headers: this.proxyHeaders() }),
    ])

    const stdoutData = stdoutRes.ok ? ((await stdoutRes.json()) as { lines: string[] }) : { lines: [] }
    const stderrData = stderrRes.ok ? ((await stderrRes.json()) as { lines: string[] }) : { lines: [] }

    return {
      exitCode: procInfo.exit_code ?? -1,
      stdout: stdoutData.lines.join('\n'),
      stderr: stderrData.lines.join('\n'),
    }
  }

  async readFile(proxyUrl: string, path: string): Promise<Buffer> {
    const res = await fetch(`${proxyUrl}/api/v1/files?path=${encodeURIComponent(path)}`, {
      headers: this.proxyHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to read file ${path}: ${res.status} ${await res.text()}`)
    const buf = await res.arrayBuffer()
    return Buffer.from(buf)
  }

  async writeFile(proxyUrl: string, path: string, content: Buffer): Promise<void> {
    const res = await fetch(`${proxyUrl}/api/v1/files?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { ...this.proxyHeaders(), 'Content-Type': 'application/octet-stream' },
      body: content as unknown as BodyInit,
    })
    if (!res.ok) throw new Error(`Failed to write file ${path}: ${res.status} ${await res.text()}`)
  }

  async listDirectory(proxyUrl: string, path: string): Promise<DirectoryEntry[]> {
    const res = await fetch(`${proxyUrl}/api/v1/files/list?path=${encodeURIComponent(path)}`, {
      headers: this.proxyHeaders(),
    })
    if (!res.ok) throw new Error(`Failed to list directory ${path}: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { path: string; entries: DirectoryEntry[] }
    return data.entries
  }

  async health(proxyUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${proxyUrl}/api/v1/health`, { headers: this.proxyHeaders() })
      return res.ok
    } catch {
      return false
    }
  }
}
