import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { globToRegExp, literalPrefix } from '../core/glob-match.js'
import { shellQuote } from '../core/shell.js'

const MAX_RESULTS = 100
// Ceiling on the paths pulled back for matching. The sandbox sorts newest
// first and cuts the list there, so a generated or vendored tree with millions
// of files cannot flood this process.
const MAX_SCAN = 20_000

export const globTool = (
  sessionManager: TensorlakeSessionManager,
  pluginCtx: PluginInput,
) => ({
  description:
    'Finds files matching a glob pattern in the Tensorlake sandbox. The pattern is matched against the ' +
    'path relative to `path` (the project directory by default). `*` and `?` stop at a directory ' +
    "separator, so use `**` to descend: `**/*.ts`, not `*.ts`. Results are newest first, at most " +
    `${MAX_RESULTS}. The search itself looks at the ${MAX_SCAN} newest files under \`path\`.`,
  args: {
    pattern: z.string(),
    path: z.string().optional(),
  },
  async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, pluginCtx)
    const base = (args.path ?? sessionManager.projectDir()).replace(/\/+$/, '')
    const prefix = literalPrefix(args.pattern)
    const root = prefix ? `${base}/${prefix}` : base

    const { entries, scanTruncated } = await listFiles(sessionManager, sandboxId, root)
    const regex = globToRegExp(args.pattern)
    const matched = entries.filter((entry) => {
      const relative = entry.path.startsWith(`${base}/`) ? entry.path.slice(base.length + 1) : entry.path
      return regex.test(relative) || regex.test(entry.path)
    })
    if (matched.length === 0) {
      return scanTruncated
        ? `(no matches in the ${MAX_SCAN} newest files under ${root}; narrow the pattern or set path)`
        : '(no matches)'
    }

    matched.sort((a, b) => b.mtime - a.mtime)
    const shown = matched.slice(0, MAX_RESULTS)
    const output = shown.map((entry) => entry.path).join('\n')
    const notes: string[] = []
    if (matched.length > shown.length) {
      notes.push(`showing ${shown.length} of ${matched.length} matches`)
    }
    if (scanTruncated) {
      notes.push(`only the ${MAX_SCAN} newest files under ${root} were searched`)
    }
    return notes.length > 0
      ? `${output}\n\n(${notes.join('; ')}; narrow the pattern or set path)`
      : output
  },
})

/**
 * Lists files under `root`, newest first when the sandbox has GNU find.
 * Busybox find has no -printf and writes nothing, so a second pass collects the
 * paths without timestamps rather than leaving the tool with no results. Both
 * passes cut the list in the sandbox: the host never holds the whole tree.
 */
async function listFiles(
  sessionManager: TensorlakeSessionManager,
  sandboxId: string,
  root: string,
): Promise<{ entries: Array<{ path: string; mtime: number }>; scanTruncated: boolean }> {
  const client = sessionManager.getClient()
  const find = `find ${shellQuote(root)} -type f -not -path '*/.git/*'`
  // One line over the cap tells us whether the tree was larger than the scan.
  const cut = `head -n ${MAX_SCAN + 1}`
  const timed = await client.executeCommand(sandboxId, `${find} -printf '%T@ %p\\n' 2>/dev/null | sort -rn | ${cut}`, '/')
  const timedLines = splitLines(timed.stdout)
  if (timedLines.length > 0) {
    return {
      entries: timedLines.slice(0, MAX_SCAN).map((line) => {
        const match = /^(\d+(?:\.\d+)?) (.*)$/.exec(line)
        return match ? { path: match[2], mtime: Number(match[1]) } : { path: line, mtime: 0 }
      }),
      scanTruncated: timedLines.length > MAX_SCAN,
    }
  }
  const plain = await client.executeCommand(sandboxId, `${find} 2>/dev/null | ${cut}`, '/')
  const plainLines = splitLines(plain.stdout)
  return {
    entries: plainLines.slice(0, MAX_SCAN).map((path) => ({ path, mtime: 0 })),
    scanTruncated: plainLines.length > MAX_SCAN,
  }
}

function splitLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line !== '')
}
