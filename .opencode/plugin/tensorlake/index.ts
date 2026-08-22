import { join } from 'path'
import { xdgData } from 'xdg-basedir'
import type { PluginInput } from '@opencode-ai/plugin'
import { setLogFilePath, logger } from './core/logger.js'
import { resolveApiKey } from './core/credentials.js'
import { resolveProjectContext } from './core/project-context.js'
import { detectSyncMode } from './core/project-sync.js'
import { TensorlakeSessionManager } from './core/session-manager.js'
import { toast } from './core/toast.js'
import { authHook } from './plugins/auth.js'
import { customTools } from './plugins/custom-tools.js'
import { eventHandlers } from './plugins/session-events.js'
import { systemPromptTransform } from './plugins/system-transform.js'

const LOG_FILE = join(xdgData ?? '/tmp', 'opencode', 'log', 'tensorlake.log')
const STORAGE_DIR = join(xdgData ?? '/tmp', 'opencode', 'storage', 'tensorlake')
const WORK_DIR = '/tmp/workspace'

setLogFilePath(LOG_FILE)
const sessionManager = new TensorlakeSessionManager(resolveApiKey, STORAGE_DIR, WORK_DIR)

function suspendAndExit(signal: string) {
  logger.info(`Received ${signal}, suspending sandboxes before exit`)
  try {
    sessionManager.suspendAllSandboxes()
  } catch (err) {
    logger.error(`Failed to suspend sandboxes on ${signal}: ${err}`)
  }
  process.exit(0)
}

process.on('SIGTERM', () => suspendAndExit('SIGTERM'))
process.on('SIGINT', () => suspendAndExit('SIGINT'))

async function tensorlakePlugin(ctx: PluginInput) {
  toast.initialize(ctx.client?.tui)
  const { worktree } = resolveProjectContext(ctx)
  // Resolve the sync mode once, before anything reads it: detecting a local
  // Tensorlake mount needs the CLI, and every later read is synchronous.
  await detectSyncMode(worktree)
  const projectDir = sessionManager.projectDir(worktree)
  return {
    auth: authHook,
    tool: await customTools(ctx, sessionManager),
    event: await eventHandlers(ctx, sessionManager),
    'experimental.chat.system.transform': await systemPromptTransform(ctx, WORK_DIR, projectDir),
  }
}

export default tensorlakePlugin
