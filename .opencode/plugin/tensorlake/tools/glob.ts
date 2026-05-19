import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorLakeSessionManager } from '../core/session-manager.js'

export const globTool = (
  sessionManager: TensorLakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Finds files matching a glob pattern in the TensorLake sandbox',
  args: {
    pattern: z.string(),
    path: z.string().optional(),
  },
  async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const searchPath = args.path ?? sessionManager.workDir
    const result = await sessionManager
      .getClient()
      .executeCommand(sandboxId, `find ${searchPath} -name "${args.pattern}" 2>/dev/null`, '/')
    return result.stdout.trim() || '(no matches)'
  },
})
