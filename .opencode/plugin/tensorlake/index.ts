import { join } from 'path'
import { xdgData } from 'xdg-basedir'
import type { PluginInput } from '@opencode-ai/plugin'
import { setLogFilePath } from './core/logger.js'
import { TensorLakeSessionManager } from './core/session-manager.js'
import { toast } from './core/toast.js'
import { customTools } from './plugins/custom-tools.js'
import { eventHandlers } from './plugins/session-events.js'
import { systemPromptTransform } from './plugins/system-transform.js'

const LOG_FILE = join(xdgData ?? '/tmp', 'opencode', 'log', 'tensorlake.log')
const STORAGE_DIR = join(xdgData ?? '/tmp', 'opencode', 'storage', 'tensorlake')
const WORK_DIR = '/workspace'

setLogFilePath(LOG_FILE)
const sessionManager = new TensorLakeSessionManager(
  process.env.TENSORLAKE_API_KEY ?? '',
  STORAGE_DIR,
  WORK_DIR,
)

async function tensorlakePlugin(ctx: PluginInput) {
  toast.initialize(ctx.client?.tui)
  return {
    tool: await customTools(ctx, sessionManager),
    event: await eventHandlers(ctx, sessionManager),
    'experimental.chat.system.transform': await systemPromptTransform(ctx, WORK_DIR),
  }
}

export default tensorlakePlugin
