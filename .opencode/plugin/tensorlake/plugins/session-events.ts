import type { PluginInput } from '@opencode-ai/plugin'
import {
  EVENT_TYPE_SESSION_DELETED,
  EVENT_TYPE_SESSION_IDLE,
  EVENT_TYPE_SERVER_INSTANCE_DISPOSED,
  type EventSessionDeleted,
  type EventSessionIdle,
} from '../core/types.js'
import { toast } from '../core/toast.js'
import { logger } from '../core/logger.js'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { resolveProjectContext } from '../core/project-context.js'

export async function eventHandlers(ctx: PluginInput, sessionManager: TensorlakeSessionManager) {
  const { projectId, worktree } = resolveProjectContext(ctx)
  return async (args: any) => {
    const event = args.event
    if (event.type === EVENT_TYPE_SESSION_IDLE) {
      // The agent just finished a turn: pull whatever it pushed to the sync repo
      // back into the local checkout. Failures are logged inside syncBack.
      const sessionId = (event as EventSessionIdle).properties.sessionID
      await sessionManager.syncBack(sessionId, projectId, worktree)
    } else if (event.type === EVENT_TYPE_SESSION_DELETED) {
      const sessionId = (event as EventSessionDeleted).properties.info.id
      try {
        await sessionManager.deleteSandbox(sessionId, projectId, worktree)
        toast.show({ title: 'Session deleted', message: 'Sandbox deleted successfully.', variant: 'success' })
      } catch (err: any) {
        logger.error(`Failed to delete sandbox: ${err}`)
        toast.show({ title: 'Delete failed', message: err?.message ?? 'Failed to delete sandbox.', variant: 'error' })
      }
    } else if (event.type === EVENT_TYPE_SERVER_INSTANCE_DISPOSED) {
      try {
        sessionManager.suspendAllSandboxes()
      } catch (err: any) {
        logger.error(`Failed to suspend sandboxes on exit: ${err}`)
      }
    }
  }
}
