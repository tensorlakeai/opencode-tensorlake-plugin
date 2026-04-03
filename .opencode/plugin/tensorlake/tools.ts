import type { TensorLakeSessionManager } from './core/session-manager.js'
import type { PluginInput } from '@opencode-ai/plugin'
import { bashTool } from './tools/bash.js'
import { readTool } from './tools/read.js'
import { writeTool } from './tools/write.js'
import { editTool } from './tools/edit.js'
import { lsTool } from './tools/ls.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'

export function createTensorLakeTools(
  sessionManager: TensorLakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) {
  return {
    bash: bashTool(sessionManager, projectId, worktree, pluginCtx),
    read: readTool(sessionManager, projectId, worktree, pluginCtx),
    write: writeTool(sessionManager, projectId, worktree, pluginCtx),
    edit: editTool(sessionManager, projectId, worktree, pluginCtx),
    ls: lsTool(sessionManager, projectId, worktree, pluginCtx),
    glob: globTool(sessionManager, projectId, worktree, pluginCtx),
    grep: grepTool(sessionManager, projectId, worktree, pluginCtx),
  }
}
