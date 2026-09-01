import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_LINE_LENGTH = 250
// Byte cut applied per line in the sandbox. Well above MAX_LINE_LENGTH
// characters, so the host still does the display truncation and drops any
// partial character this leaves behind, but a minified one-line bundle can no
// longer send megabytes back for a single match.
const MAX_LINE_BYTES = 1024

export const grepTool = (
  sessionManager: TensorlakeSessionManager,
  pluginCtx: PluginInput,
) => ({
  description:
    'Searches for a text pattern in files in the Tensorlake sandbox. `include` narrows the search to ' +
    'files matching a name pattern (for example `*.ts`). At most `limit` matching lines are returned ' +
    `(default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}); long lines are shortened.`,
  args: {
    pattern: z.string(),
    path: z.string().optional(),
    include: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  },
  async execute(
    args: { pattern: string; path?: string; include?: string; limit?: number },
    ctx: ToolContext,
  ) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, pluginCtx)
    const searchPath = args.path ?? sessionManager.projectDir()
    // Clamp as well as validate: a client that skips schema checks still
    // cannot ask for an unbounded result set.
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const include = args.include ? `--include=${shellQuote(args.include)}` : ''
    // One line over the limit tells us whether anything was cut off. `head`
    // also caps what a runaway search can pull back into the model's context.
    const cmd =
      `grep -rn --binary-files=without-match --exclude-dir=.git ${include} ` +
      `-e ${shellQuote(args.pattern)} -- ${shellQuote(searchPath)} 2>/dev/null | ` +
      `cut -b -${MAX_LINE_BYTES} | head -n ${limit + 1}`
    const result = await sessionManager.getClient().executeCommand(sandboxId, cmd, '/')

    const lines = result.stdout.split('\n').filter((line) => line !== '')
    if (lines.length === 0) return '(no matches)'
    const shown = lines
      .slice(0, limit)
      .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… (line truncated)` : line))
    const output = shown.join('\n')
    return lines.length > limit
      ? `${output}\n\n(stopped at ${limit} matches; narrow the pattern, set include, or raise limit)`
      : output
  },
})
