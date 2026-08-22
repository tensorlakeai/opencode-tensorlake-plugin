import { createHash } from 'crypto'
import { existsSync, realpathSync } from 'fs'
import { resolve } from 'path'
import type { PluginInput } from '@opencode-ai/plugin'

/** OpenCode's project id for a directory that is not in a version-controlled repo. */
const GLOBAL_PROJECT_ID = 'global'

export type ProjectContext = {
  /** Absolute path of the local project on this machine. */
  worktree: string
  /**
   * Identity used for the sync resource name (hosted git repo or cloud volume)
   * and the local session store.
   */
  projectId: string
}

/**
 * Resolve the local project from the plugin input.
 *
 * OpenCode only fills `project.worktree` for a repository. A plain folder gets
 * the shared 'global' project, whose worktree is the literal '/' — which is not
 * a project path and must never be synced. In that case the session directory
 * (`ctx.directory`) is the project, and the id is derived from it so that two
 * different plain folders never share a volume, a hosted repo, or a sandbox.
 */
export function resolveProjectContext(ctx: PluginInput): ProjectContext {
  const reported = ctx.project?.worktree ?? ''
  const projectId = ctx.project?.id ?? ''
  if (isUsableWorktree(reported) && projectId && projectId !== GLOBAL_PROJECT_ID) {
    return { worktree: canonical(reported), projectId }
  }

  const fallback = [ctx.worktree, ctx.directory].find(isUsableWorktree)
  if (!fallback) return { worktree: '', projectId: projectId || GLOBAL_PROJECT_ID }

  const worktree = canonical(fallback)
  return { worktree, projectId: projectId === GLOBAL_PROJECT_ID ? folderProjectId(worktree) : projectId }
}

function isUsableWorktree(path: string | undefined): path is string {
  if (!path || path === '/') return false
  return existsSync(path)
}

/**
 * The path as the filesystem itself spells it. On a case-insensitive volume
 * (macOS, Windows) the same folder can be entered as .../gtm/... or .../GTM/...;
 * without this each spelling would hash to a different id and get its own
 * cloud volume and sandbox.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** Stable per-folder id for a plain (non-repository) directory. */
function folderProjectId(worktree: string): string {
  return `folder-${createHash('sha1').update(worktree).digest('hex').slice(0, 16)}`
}
