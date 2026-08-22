import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

export const globTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Finds files matching a glob pattern in the Tensorlake sandbox',
  args: {
    pattern: z.string(),
    path: z.string().optional(),
  },
  async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const searchPath = args.path ?? sessionManager.projectDir(worktree)
    const result = await sessionManager
      .getClient()
      .executeCommand(sandboxId, `find ${shellQuote(searchPath)} -name ${shellQuote(args.pattern)} 2>/dev/null`, '/')
    return result.stdout.trim() || '(no matches)'
  },
})
