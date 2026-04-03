import type { PluginInput } from '@opencode-ai/plugin'
import { EVENT_TYPE_SESSION_DELETED, EVENT_TYPE_SERVER_INSTANCE_DISPOSED, type EventSessionDeleted } from '../core/types.js'
import { toast } from '../core/toast.js'
import { logger } from '../core/logger.js'
import type { TensorLakeSessionManager } from '../core/session-manager.js'

export async function eventHandlers(ctx: PluginInput, sessionManager: TensorLakeSessionManager) {
  const projectId = ctx.project.id
  return async (args: any) => {
    const event = args.event
    if (event.type === EVENT_TYPE_SESSION_DELETED) {
      const sessionId = (event as EventSessionDeleted).properties.info.id
      try {
        await sessionManager.deleteSandbox(sessionId, projectId)
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
