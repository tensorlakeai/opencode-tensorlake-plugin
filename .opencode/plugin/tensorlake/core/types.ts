export type EventSessionDeleted = {
  type: 'session.deleted'
  properties: {
    info: { id: string }
  }
}

export type EventSessionIdle = {
  type: 'session.idle'
  properties: {
    sessionID: string
  }
}

export type ExperimentalChatSystemTransformInput = {
  sessionID?: string
  model: any
}

export type ExperimentalChatSystemTransformOutput = {
  system: string[]
}

export const EVENT_TYPE_SESSION_DELETED = 'session.deleted'
export const EVENT_TYPE_SESSION_IDLE = 'session.idle'
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
