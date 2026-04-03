import type { PluginInput } from '@opencode-ai/plugin'
import { createTensorLakeTools } from '../tools.js'
import { logger } from '../core/logger.js'
import type { TensorLakeSessionManager } from '../core/session-manager.js'

export async function customTools(ctx: PluginInput, sessionManager: TensorLakeSessionManager) {
  logger.info('OpenCode started with TensorLake plugin')
  return createTensorLakeTools(sessionManager, ctx.project.id, ctx.project.worktree, ctx)
}
