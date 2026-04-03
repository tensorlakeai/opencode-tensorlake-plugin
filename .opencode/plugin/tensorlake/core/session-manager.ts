import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { TensorLakeClient, getSandboxProxyUrl } from './client.js'
import { logger } from './logger.js'
import { toast } from './toast.js'
import type { ProjectSessionData, SessionInfo } from './types.js'
import type { PluginInput } from '@opencode-ai/plugin'

export class TensorLakeSessionManager {
  private readonly client: TensorLakeClient
  // In-memory cache: sessionId -> { sandboxId, proxyUrl }
  private readonly cache = new Map<string, { sandboxId: string; proxyUrl: string }>()
  public readonly workDir: string
  private readonly storageDir: string

  constructor(apiKey: string, storageDir: string, workDir: string) {
    this.client = new TensorLakeClient(apiKey)
    this.storageDir = storageDir
    this.workDir = workDir
  }

  getClient(): TensorLakeClient {
    return this.client
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
    proxyUrl: string,
  ): void {
    const existing = this.loadProjectData(projectId) ?? { projectId, worktree, sessions: {} }
    existing.sessions[sessionId] = {
      sandboxId,
      proxyUrl,
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

  async getSandbox(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<{ sandboxId: string; proxyUrl: string }> {
    if (pluginCtx?.client?.tui) toast.initialize(pluginCtx.client.tui)

    if (!this.client.hasApiKey()) {
      const msg = 'TENSORLAKE_API_KEY is not set. Please set the environment variable.'
      toast.show({ title: 'Sandbox error', message: msg, variant: 'error' })
      throw new Error(msg)
    }

    // Check in-memory cache
    const cached = this.cache.get(sessionId)
    if (cached) {
      // Verify it's still running
      try {
        const info = await this.client.getSandbox(cached.sandboxId)
        if (info.status === 'suspended') {
          logger.info(`Resuming sandbox ${cached.sandboxId}`)
          await this.client.resumeSandbox(cached.sandboxId)
          await this.client.waitForRunning(cached.sandboxId)
          toast.show({ title: 'Sandbox resumed', message: 'Sandbox resumed from suspension.', variant: 'info' })
        } else if (info.status === 'terminated') {
          logger.warn(`Sandbox ${cached.sandboxId} was terminated, creating new one`)
          this.cache.delete(sessionId)
          this.removeSession(projectId, sessionId)
          return this.getSandbox(sessionId, projectId, worktree, pluginCtx)
        }
        this.updateSession(projectId, worktree, sessionId, cached.sandboxId, cached.proxyUrl)
        return cached
      } catch (err) {
        logger.warn(`Failed to check cached sandbox: ${err}`)
        this.cache.delete(sessionId)
      }
    }

    // Check persistent storage
    const projectData = this.loadProjectData(projectId)
    const stored = projectData?.sessions[sessionId]
    if (stored) {
      logger.info(`Reconnecting to sandbox ${stored.sandboxId} for session ${sessionId}`)
      try {
        const info = await this.client.getSandbox(stored.sandboxId)
        if (info.status === 'suspended') {
          await this.client.resumeSandbox(stored.sandboxId)
          await this.client.waitForRunning(stored.sandboxId)
        } else if (info.status === 'terminated') {
          this.removeSession(projectId, sessionId)
          return this.getSandbox(sessionId, projectId, worktree, pluginCtx)
        } else if (info.status !== 'running') {
          await this.client.waitForRunning(stored.sandboxId)
        }
        const entry = { sandboxId: stored.sandboxId, proxyUrl: stored.proxyUrl }
        this.cache.set(sessionId, entry)
        this.updateSession(projectId, worktree, sessionId, stored.sandboxId, stored.proxyUrl)
        toast.show({ title: 'Sandbox connected', message: 'Connected to existing sandbox.', variant: 'info' })
        return entry
      } catch (err) {
        logger.warn(`Failed to reconnect to sandbox ${stored.sandboxId}: ${err}`)
        this.removeSession(projectId, sessionId)
      }
    }

    // Create new sandbox
    logger.info(`Creating new sandbox for session ${sessionId}`)
    const createStart = Date.now()
    const image = process.env.TENSORLAKE_IMAGE
    const created = await this.client.createSandbox(image ? { image } : {})
    logger.info(`Sandbox created ${created.sandbox_id} in ${Date.now() - createStart}ms`)

    await this.client.waitForRunning(created.sandbox_id)

    // Ensure workspace dir exists
    const proxyUrl = getSandboxProxyUrl(created.sandbox_id)
    try {
      await this.client.executeCommand(proxyUrl, `mkdir -p ${this.workDir}`, '/')
    } catch (err) {
      logger.warn(`Failed to create workspace dir: ${err}`)
    }

    const entry = { sandboxId: created.sandbox_id, proxyUrl }
    this.cache.set(sessionId, entry)
    this.updateSession(projectId, worktree, sessionId, created.sandbox_id, proxyUrl)

    toast.show({ title: 'Sandbox created', message: 'New sandbox is ready.', variant: 'success' })
    return entry
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
