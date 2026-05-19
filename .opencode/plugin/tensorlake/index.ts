import { join } from 'path'
import { xdgData } from 'xdg-basedir'
import type { PluginInput } from '@opencode-ai/plugin'
import { setLogFilePath, logger } from './core/logger.js'
import { TensorLakeSessionManager } from './core/session-manager.js'
import { toast } from './core/toast.js'
import { customTools } from './plugins/custom-tools.js'
import { eventHandlers } from './plugins/session-events.js'
import { systemPromptTransform } from './plugins/system-transform.js'

const LOG_FILE = join(xdgData ?? '/tmp', 'opencode', 'log', 'tensorlake.log')
const STORAGE_DIR = join(xdgData ?? '/tmp', 'opencode', 'storage', 'tensorlake')
const WORK_DIR = '/tmp/workspace'

setLogFilePath(LOG_FILE)
const sessionManager = new TensorLakeSessionManager(
  process.env.TENSORLAKE_API_KEY ?? '',
  STORAGE_DIR,
  WORK_DIR,
)

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
  return {
    tool: await customTools(ctx, sessionManager),
    event: await eventHandlers(ctx, sessionManager),
    'experimental.chat.system.transform': await systemPromptTransform(ctx, WORK_DIR),
  }
}

export default tensorlakePlugin
