import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { globToRegExp, literalPrefix } from '../core/glob-match.js'
import { shellQuote } from '../core/shell.js'

const MAX_RESULTS = 100

export const globTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Finds files matching a glob pattern in the Tensorlake sandbox. The pattern is matched against the ' +
    'path relative to `path` (the project directory by default). `*` and `?` stop at a directory ' +
    "separator, so use `**` to descend: `**/*.ts`, not `*.ts`. Results are newest first, at most " +
    `${MAX_RESULTS}.`,
  args: {
    pattern: z.string(),
    path: z.string().optional(),
  },
  async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const base = (args.path ?? sessionManager.projectDir(worktree)).replace(/\/+$/, '')
    const prefix = literalPrefix(args.pattern)
    const root = prefix ? `${base}/${prefix}` : base

    const entries = await listFiles(sessionManager, sandboxId, root)
    const regex = globToRegExp(args.pattern)
    const matched = entries.filter((entry) => {
      const relative = entry.path.startsWith(`${base}/`) ? entry.path.slice(base.length + 1) : entry.path
      return regex.test(relative) || regex.test(entry.path)
    })
    if (matched.length === 0) return '(no matches)'

    matched.sort((a, b) => b.mtime - a.mtime)
    const shown = matched.slice(0, MAX_RESULTS)
    const output = shown.map((entry) => entry.path).join('\n')
    return matched.length > shown.length
      ? `${output}\n\n(showing ${shown.length} of ${matched.length} matches; narrow the pattern or set path)`
      : output
  },
})

/**
 * Lists every file under `root`, newest first when the sandbox has GNU find.
 * Busybox find has no -printf and writes nothing, so a second pass collects the
 * paths without timestamps rather than leaving the tool with no results.
 */
async function listFiles(
  sessionManager: TensorlakeSessionManager,
  sandboxId: string,
  root: string,
): Promise<Array<{ path: string; mtime: number }>> {
  const client = sessionManager.getClient()
  const find = `find ${shellQuote(root)} -type f -not -path '*/.git/*'`
  const timed = await client.executeCommand(sandboxId, `${find} -printf '%T@ %p\\n' 2>/dev/null`, '/')
  const timedLines = splitLines(timed.stdout)
  if (timedLines.length > 0) {
    return timedLines.map((line) => {
      const match = /^(\d+(?:\.\d+)?) (.*)$/.exec(line)
      return match ? { path: match[2], mtime: Number(match[1]) } : { path: line, mtime: 0 }
    })
  }
  const plain = await client.executeCommand(sandboxId, `${find} 2>/dev/null`, '/')
  return splitLines(plain.stdout).map((path) => ({ path, mtime: 0 }))
}

function splitLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line !== '')
}
