import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

export const syncTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    "Re-syncs the user's local project into the sandbox now. Use when the user says they edited files, committed, or switched branches locally and the sandbox should pick that up. In git mode it pushes the local state (including uncommitted changes) and pulls agent commits back; in volume mode it re-uploads local files, replacing the volume's copies of them.",
  args: {},
  async execute(_args: Record<string, never>, ctx: ToolContext) {
    return sessionManager.syncNow(ctx.sessionID, projectId, worktree, pluginCtx)
  },
})
