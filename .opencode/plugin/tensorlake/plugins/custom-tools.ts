import type { PluginInput } from '@opencode-ai/plugin'
import { createTensorlakeTools } from '../tools.js'
import { logger } from '../core/logger.js'
import { resolveProjectContext } from '../core/project-context.js'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

export async function customTools(ctx: PluginInput, sessionManager: TensorlakeSessionManager) {
  const { projectId, worktree } = resolveProjectContext(ctx)
  logger.info(`OpenCode started with Tensorlake plugin (project=${projectId}, worktree=${worktree || '(none)'})`)
  return createTensorlakeTools(sessionManager, projectId, worktree, ctx)
}
