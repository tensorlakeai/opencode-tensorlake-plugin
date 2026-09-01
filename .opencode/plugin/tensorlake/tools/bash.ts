import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

export const bashTool = (
  sessionManager: TensorlakeSessionManager,
  pluginCtx: PluginInput,
) => ({
  description: 'Executes shell commands in a Tensorlake sandbox',
  args: {
    command: z.string(),
  },
  async execute(args: { command: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, pluginCtx)
    const workDir = sessionManager.projectDir()
    const result = await sessionManager.getClient().executeCommand(sandboxId, args.command, workDir)
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    return `Exit code: ${result.exitCode}\n${output}`
  },
})
