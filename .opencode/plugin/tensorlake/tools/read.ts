import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000

export const readTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Reads a file from the Tensorlake sandbox. Output is one numbered line per source line. ' +
    '`offset` is the 0-based line to start at and `limit` is how many lines to return ' +
    `(default ${DEFAULT_LIMIT}). Use them to page through a file that is too long to read at once.`,
  args: {
    filePath: z.string(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).optional(),
  },
  async execute(args: { filePath: string; offset?: number; limit?: number }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const buffer = await sessionManager.getClient().readFile(sandboxId, args.filePath)
    return formatFile(new TextDecoder().decode(buffer), args.offset ?? 0, args.limit ?? DEFAULT_LIMIT)
  },
})

export function formatFile(text: string, offset: number, limit: number): string {
  const lines = text.split('\n')
  // A trailing newline leaves an empty last element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return '(empty file)'

  const selected = lines.slice(offset, offset + limit)
  if (selected.length === 0) {
    return `(offset ${offset} is past the end of the file, which has ${lines.length} lines)`
  }

  const body = selected
    .map((line, index) => {
      const number = String(offset + index + 1).padStart(5, '0')
      const shown = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… (line truncated)` : line
      return `${number}| ${shown}`
    })
    .join('\n')

  const end = offset + selected.length
  const output = `<file>\n${body}\n</file>`
  return end < lines.length
    ? `${output}\n\n(showing lines ${offset + 1}-${end} of ${lines.length}; read on with offset=${end})`
    : output
}
