import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorLakeSessionManager } from '../core/session-manager.js'

export const readTool = (
  sessionManager: TensorLakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Reads a file from the TensorLake sandbox',
  args: {
    filePath: z.string(),
  },
  async execute(args: { filePath: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const buffer = await sessionManager.getClient().readFile(sandboxId, args.filePath)
    return new TextDecoder().decode(buffer)
  },
})
