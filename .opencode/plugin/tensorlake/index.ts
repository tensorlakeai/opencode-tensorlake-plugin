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

let exitRequested = false

function suspendNowAndExit(signal: string) {
  try {
    sessionManager.suspendAllSandboxes()
  } catch (err) {
    logger.error(`Failed to suspend sandboxes on ${signal}: ${err}`)
  }
  process.exit(0)
}

/**
 * Exit path for SIGINT/SIGTERM. Background work carries agent changes between
 * the sandbox and the user's machine (inbound sync, sync-back, uncommitted-work
 * capture, volume download, setup), so it has to finish before the sandboxes
 * are suspended — cutting it off loses the work. With nothing pending the old
 * synchronous path is kept, so an idle exit is as fast (and as robust against
 * another handler exiting first) as before. A second signal skips the wait.
 */
function suspendAndExit(signal: string) {
  if (exitRequested) {
    logger.warn(`Received ${signal} again, suspending without waiting for pending work`)
    suspendNowAndExit(signal)
    return
  }
  exitRequested = true
  if (!sessionManager.hasPendingWork()) {
    logger.info(`Received ${signal}, suspending sandboxes before exit`)
    suspendNowAndExit(signal)
    return
  }
  logger.info(`Received ${signal}, finishing pending work before suspending sandboxes`)
  sessionManager
    .shutdown(signal)
    .catch((err) => logger.error(`Failed to shut down cleanly on ${signal}: ${err}`))
    .finally(() => process.exit(0))
}

process.on('SIGTERM', () => suspendAndExit('SIGTERM'))
process.on('SIGINT', () => suspendAndExit('SIGINT'))

async function tensorlakePlugin(ctx: PluginInput, options?: Record<string, unknown>) {
  toast.initialize(ctx.client?.tui)
  const { worktree } = resolveProjectContext(ctx)
  // Post-sync setup command (dependency install, seed data). Configured as a
  // plugin option in opencode.json — ["tensorlake-opencode", {"setup": "npm ci"}]
  // — so it can live in the project's own opencode.json; the env var wins.
  const setup = process.env.TENSORLAKE_SETUP_COMMAND ?? (typeof options?.setup === 'string' ? options.setup : undefined)
  sessionManager.setSetupCommand(setup)
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
