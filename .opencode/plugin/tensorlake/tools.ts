import type { TensorlakeSessionManager } from './core/session-manager.js'
import type { PluginInput } from '@opencode-ai/plugin'
import { bashTool, bashOutputTool, bashKillTool } from './tools/bash.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { lsTool } from './tools/ls.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'
import { syncTool } from './tools/sync.js'

export function createTensorlakeTools(
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) {
  return {
    bash: bashTool(sessionManager, projectId, worktree, pluginCtx),
    bash_output: bashOutputTool(sessionManager, projectId, worktree, pluginCtx),
    bash_kill: bashKillTool(sessionManager, projectId, worktree, pluginCtx),
    sync: syncTool(sessionManager, projectId, worktree, pluginCtx),
    read: readTool(sessionManager, projectId, worktree, pluginCtx),
    write: writeTool(sessionManager, projectId, worktree, pluginCtx),
    edit: editTool(sessionManager, projectId, worktree, pluginCtx),
    ls: lsTool(sessionManager, projectId, worktree, pluginCtx),
    glob: globTool(sessionManager, projectId, worktree, pluginCtx),
    grep: grepTool(sessionManager, projectId, worktree, pluginCtx),
  }
}
