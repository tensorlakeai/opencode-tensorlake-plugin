import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorLakeSessionManager } from '../core/session-manager.js'

export const bashTool = (
  sessionManager: TensorLakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Executes shell commands in a TensorLake sandbox',
  args: {
    command: z.string(),
    background: z.boolean().optional(),
  },
  async execute(args: { command: string; background?: boolean }, ctx: ToolContext) {
    const { proxyUrl } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const client = sessionManager.getClient()
    const workDir = sessionManager.workDir

    if (args.background) {
      // Fire and forget - start the process but don't wait
      client.executeCommand(proxyUrl, args.command, workDir, 300_000).catch(() => {})
      return `Command started in background: ${args.command}`
    }

    const result = await client.executeCommand(proxyUrl, args.command, workDir)
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    return `Exit code: ${result.exitCode}\n${output}`
  },
})
