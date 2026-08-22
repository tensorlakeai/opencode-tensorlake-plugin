import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

export const grepTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Searches for a text pattern in files in the Tensorlake sandbox',
  args: {
    pattern: z.string(),
    path: z.string().optional(),
    filePattern: z.string().optional(),
  },
  async execute(args: { pattern: string; path?: string; filePattern?: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const searchPath = args.path ?? sessionManager.projectDir(worktree)
    const include = args.filePattern ? `--include=${shellQuote(args.filePattern)}` : ''
    const cmd = `grep -rn ${include} -e ${shellQuote(args.pattern)} -- ${shellQuote(searchPath)} 2>/dev/null`
    const result = await sessionManager.getClient().executeCommand(sandboxId, cmd, '/')
    return result.stdout.trim() || '(no matches)'
  },
})
