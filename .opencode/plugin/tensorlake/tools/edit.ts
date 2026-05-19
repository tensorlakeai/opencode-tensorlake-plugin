import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorLakeSessionManager } from '../core/session-manager.js'

export const editTool = (
  sessionManager: TensorLakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Replaces a string in a file in the TensorLake sandbox',
  args: {
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
  },
  async execute(args: { filePath: string; oldString: string; newString: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const client = sessionManager.getClient()
    const buffer = await client.readFile(sandboxId, args.filePath)
    const content = new TextDecoder().decode(buffer)
    const newContent = content.replace(args.oldString, args.newString)
    await client.writeFile(sandboxId, args.filePath, Buffer.from(newContent))
    return `Edited ${args.filePath}`
  },
})
