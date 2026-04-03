import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorLakeSessionManager } from '../core/session-manager.js'

export const writeTool = (
  sessionManager: TensorLakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Writes content to a file in the TensorLake sandbox',
  args: {
    filePath: z.string(),
    content: z.string(),
  },
  async execute(args: { filePath: string; content: string }, ctx: ToolContext) {
    const { proxyUrl } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const buf = Buffer.from(args.content)
    // Ensure parent directory exists
    const dir = args.filePath.split('/').slice(0, -1).join('/')
    if (dir) {
      await sessionManager.getClient().executeCommand(proxyUrl, `mkdir -p ${dir}`, '/').catch(() => {})
    }
    await sessionManager.getClient().writeFile(proxyUrl, args.filePath, buf)
    return `Written ${buf.length} bytes to ${args.filePath}`
  },
})
