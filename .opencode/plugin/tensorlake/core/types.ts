/** The part of OpenCode's session object the plugin reads. */
export type SessionRef = {
  id: string
  /** Set on a subagent session; the session that spawned it. */
  parentID?: string
}

export type EventSessionCreated = {
  type: 'session.created'
  properties: {
    info: SessionRef
  }
}

export type EventSessionDeleted = {
  type: 'session.deleted'
  properties: {
    info: SessionRef
  }
}

export type ExperimentalChatSystemTransformInput = {
  sessionID?: string
  model: any
}

export type ExperimentalChatSystemTransformOutput = {
  system: string[]
}

export const EVENT_TYPE_SESSION_CREATED = 'session.created'
export const EVENT_TYPE_SESSION_DELETED = 'session.deleted'
export const EVENT_TYPE_SERVER_INSTANCE_DISPOSED = 'server.instance.disposed'

export type LogLevel = 'INFO' | 'ERROR' | 'WARN'

export type SandboxStatus = 'pending' | 'running' | 'snapshotting' | 'suspended' | 'terminated'

export type SandboxRecord = {
  sandboxId: string
  status: SandboxStatus
  proxyUrl: string
}

export type SessionInfo = {
  sandboxId: string
  proxyUrl?: string
  created: number
  lastAccessed: number
}

export type ProjectSessionData = {
  projectId: string
  worktree: string
  sessions: Record<string, SessionInfo>
}
