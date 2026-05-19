import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { TensorLakeClient } from './client.js'
import { logger } from './logger.js'
import { toast } from './toast.js'
import type { ProjectSessionData } from './types.js'
import type { PluginInput } from '@opencode-ai/plugin'

export class TensorLakeSessionManager {
  private readonly client: TensorLakeClient
  // In-memory cache: sessionId -> { sandboxId }
  private readonly cache = new Map<string, { sandboxId: string }>()
  // In-flight getSandbox promises keyed by sessionId — prevents concurrent double-resume
  private readonly inflight = new Map<string, Promise<{ sandboxId: string }>>()
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
      .finally(() => this.inflight.delete(sessionId))
    this.inflight.set(sessionId, promise)
    return promise
  }

  private async _getSandbox(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<{ sandboxId: string }> {
    if (pluginCtx?.client?.tui) toast.initialize(pluginCtx.client.tui)

    if (!this.client.hasApiKey()) {
      const msg = 'TENSORLAKE_API_KEY is not set. Please set the environment variable.'
      toast.show({ title: 'Sandbox error', message: msg, variant: 'error' })
      throw new Error(msg)
    }

    // Check in-memory cache
    const cached = this.cache.get(sessionId)
    if (cached) {
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
        this.updateSession(projectId, worktree, sessionId, cached.sandboxId)
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
        if (info.status === 'terminated') {
          this.removeSession(projectId, storedSessionId)
          continue
        }
        if (info.status === 'suspended' || info.status === 'suspending') {
          logger.info(`Resuming sandbox ${stored.sandboxId} (was ${info.status})`)
          if (info.status === 'suspending') await this.client.waitForSuspended(stored.sandboxId)
          await this.client.resumeSandbox(stored.sandboxId)
          await this.client.waitForRunning(stored.sandboxId)
        } else if (info.status !== 'running') {
          await this.client.waitForRunning(stored.sandboxId)
        }
        const entry = { sandboxId: stored.sandboxId }
        this.cache.set(sessionId, entry)
        this.updateSession(projectId, worktree, sessionId, stored.sandboxId)
        const reused = storedSessionId !== sessionId
        toast.show({ title: 'Sandbox connected', message: reused ? 'Reusing sandbox from previous session.' : 'Connected to existing sandbox.', variant: 'info' })
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
