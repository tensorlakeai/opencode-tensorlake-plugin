import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

const DEFAULT_LIMIT = 100
const MAX_LINE_LENGTH = 250

export const grepTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Searches for a text pattern in files in the Tensorlake sandbox. `include` narrows the search to ' +
    'files matching a name pattern (for example `*.ts`). At most `limit` matching lines are returned ' +
    `(default ${DEFAULT_LIMIT}); long lines are shortened.`,
  args: {
    pattern: z.string(),
    path: z.string().optional(),
    include: z.string().optional(),
    limit: z.number().int().min(1).optional(),
  },
  async execute(
    args: { pattern: string; path?: string; include?: string; limit?: number },
    ctx: ToolContext,
  ) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const searchPath = args.path ?? sessionManager.projectDir(worktree)
    const limit = args.limit ?? DEFAULT_LIMIT
    const include = args.include ? `--include=${shellQuote(args.include)}` : ''
    // One line over the limit tells us whether anything was cut off. `head`
    // also caps what a runaway search can pull back into the model's context.
    const cmd =
      `grep -rn --binary-files=without-match --exclude-dir=.git ${include} ` +
      `-e ${shellQuote(args.pattern)} -- ${shellQuote(searchPath)} 2>/dev/null | head -n ${limit + 1}`
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
