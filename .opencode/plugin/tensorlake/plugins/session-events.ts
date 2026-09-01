import type { PluginInput } from '@opencode-ai/plugin'
import {
  EVENT_TYPE_SESSION_CREATED,
  EVENT_TYPE_SESSION_DELETED,
  EVENT_TYPE_SERVER_INSTANCE_DISPOSED,
  type EventSessionCreated,
  type EventSessionDeleted,
} from '../core/types.js'
import { toast } from '../core/toast.js'
import { logger } from '../core/logger.js'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

export async function eventHandlers(ctx: PluginInput, sessionManager: TensorlakeSessionManager) {
  return async (args: any) => {
    const event = args.event
    if (event.type === EVENT_TYPE_SESSION_CREATED) {
      // Learn the parent link now, while the session still exists. A subagent
      // session shares its parent's sandbox, and after it is deleted the
      // server can no longer tell us who its parent was.
      const info = (event as EventSessionCreated).properties.info
      sessionManager.noteSession(info?.id, info?.parentID)
    } else if (event.type === EVENT_TYPE_SESSION_DELETED) {
      const info = (event as EventSessionDeleted).properties.info
      const sessionId = info.id
      sessionManager.noteSession(sessionId, info.parentID)
      try {
        const outcome = await sessionManager.deleteSandbox(sessionId)
        // 'detached' is a subagent session and 'none' never had a sandbox; neither is worth a toast.
        if (outcome === 'deleted') {
          toast.show({ title: 'Session deleted', message: 'Sandbox deleted successfully.', variant: 'success' })
        }
      } catch (err: any) {
        logger.error(`Failed to delete sandbox: ${err}`)
        toast.show({
          title: 'Sandbox not deleted',
          message: err?.message ?? 'Failed to delete sandbox.',
          variant: 'error',
        })
      }
    } else if (event.type === EVENT_TYPE_SERVER_INSTANCE_DISPOSED) {
      // Let in-flight sandbox work finish before the sandboxes are suspended;
      // shutdown() bounds the wait and suspends either way.
      try {
        await sessionManager.shutdown('server.instance.disposed')
      } catch (err: any) {
        logger.error(`Failed to suspend sandboxes on exit: ${err}`)
      }
    }
  }
}
