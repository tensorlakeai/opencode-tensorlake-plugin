import type { TensorlakeSessionManager } from './core/session-manager.js'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import { bashTool } from './tools/bash.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { multiEditTool } from './tools/multiedit.js'
import { applyPatchTool } from './tools/apply-patch.js'
import { lsTool } from './tools/ls.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'

type SandboxTool = { execute: (args: any, ctx: ToolContext) => unknown }

/**
 * Hold a lease on the session for as long as the tool runs, so deleting the
 * session waits for the tool instead of terminating the sandbox under it. The
 * lease is held against the session that owns the sandbox, so a subagent's
 * tool call also holds its parent's sandbox open.
 */
function leased<T extends SandboxTool>(
  sessionManager: TensorlakeSessionManager,
  pluginCtx: PluginInput,
  tool: T,
): T {
  return {
    ...tool,
    async execute(args: any, ctx: ToolContext) {
      const release = await sessionManager.leaseToolCall(ctx.sessionID, pluginCtx)
      try {
        return await tool.execute(args, ctx)
      } finally {
        release()
      }
    },
  } as T
}

export function createTensorlakeTools(
  sessionManager: TensorlakeSessionManager,
  pluginCtx: PluginInput,
) {
  return {
    bash: leased(sessionManager, pluginCtx, bashTool(sessionManager, pluginCtx)),
    read: leased(sessionManager, pluginCtx, readTool(sessionManager, pluginCtx)),
    write: leased(sessionManager, pluginCtx, writeTool(sessionManager, pluginCtx)),
    edit: leased(sessionManager, pluginCtx, editTool(sessionManager, pluginCtx)),
    multiedit: leased(sessionManager, pluginCtx, multiEditTool(sessionManager, pluginCtx)),
    // Shadows OpenCode's built-in apply_patch, which writes to the LOCAL
    // filesystem and would otherwise bypass the sandbox entirely.
    apply_patch: leased(sessionManager, pluginCtx, applyPatchTool(sessionManager, pluginCtx)),
    ls: leased(sessionManager, pluginCtx, lsTool(sessionManager, pluginCtx)),
    glob: leased(sessionManager, pluginCtx, globTool(sessionManager, pluginCtx)),
    grep: leased(sessionManager, pluginCtx, grepTool(sessionManager, pluginCtx)),
  }
}
