import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorLakeSessionManager } from '../core/session-manager.js'

export const lsTool = (
  sessionManager: TensorLakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Lists files in a directory in the TensorLake sandbox',
  args: {
    dirPath: z.string().optional(),
  },
  async execute(args: { dirPath?: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const path = args.dirPath ?? sessionManager.workDir
    const entries = await sessionManager.getClient().listDirectory(sandboxId, path)
    return entries.map((e) => (e.is_dir ? `${e.name}/` : e.name)).join('\n')
  },
})
