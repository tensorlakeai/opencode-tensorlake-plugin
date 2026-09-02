import type { PluginInput } from '@opencode-ai/plugin'
import { createTensorlakeTools } from '../tools.js'
import { logger } from '../core/logger.js'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

export async function customTools(ctx: PluginInput, sessionManager: TensorlakeSessionManager) {
  logger.info(`OpenCode started with Tensorlake plugin (directory=${ctx.directory || '(none)'})`)
  return createTensorlakeTools(sessionManager, ctx)
}
