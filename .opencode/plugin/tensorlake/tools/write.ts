import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

export const writeTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Writes content to a file in the Tensorlake sandbox',
  args: {
    filePath: z.string(),
    content: z.string(),
  },
  async execute(args: { filePath: string; content: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const buf = Buffer.from(args.content)
    const dir = args.filePath.split('/').slice(0, -1).join('/')
    if (dir) {
      await sessionManager.getClient().executeCommand(sandboxId, `mkdir -p ${shellQuote(dir)}`, '/').catch(() => {})
    }
    await sessionManager.getClient().writeFile(sandboxId, args.filePath, buf)
    return `Written ${buf.length} bytes to ${args.filePath}`
  },
})
