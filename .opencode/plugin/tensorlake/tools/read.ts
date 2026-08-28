import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 5000
const MAX_LINE_LENGTH = 2000
// Hard ceiling on the bytes one read pulls into this process. The slice is cut
// inside the sandbox, so a multi-gigabyte file never crosses the wire and a
// single very long line cannot exhaust the host.
const MAX_READ_BYTES = 4 * 1024 * 1024

const META_PREFIX = '__TL_META__ '
const NOT_FOUND = '__TL_NOFILE__'
const NOT_REGULAR = '__TL_NOTFILE__'

export const readTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Reads a file from the Tensorlake sandbox. Output is one numbered line per source line. ' +
    '`offset` is the 0-based line to start at and `limit` is how many lines to return ' +
    `(default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}). Use them to page through a file that is ` +
    'too long to read at once.',
  args: {
    filePath: z.string(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  },
  async execute(args: { filePath: string; offset?: number; limit?: number }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const offset = args.offset ?? 0
    // Clamp as well as validate: a client that skips schema checks still cannot
    // ask for an unbounded slice.
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const result = await sessionManager
      .getClient()
      .executeCommand(sandboxId, sliceCommand(args.filePath, offset, limit), '/')
    return formatSlice(result.stdout, args.filePath, offset)
  },
})

/**
 * Counts the file's lines and prints only the requested slice, cut to
 * MAX_READ_BYTES. `wc -l` counts newlines, so a file whose last line has no
 * trailing newline needs one added back.
 */
function sliceCommand(filePath: string, offset: number, limit: number): string {
  const quoted = shellQuote(filePath)
  const from = offset + 1
  const to = offset + limit
  return [
    `f=${quoted}`,
    `if [ ! -e "$f" ]; then printf '%s\\n' ${shellQuote(NOT_FOUND)}; exit 0; fi`,
    `if [ ! -f "$f" ]; then printf '%s\\n' ${shellQuote(NOT_REGULAR)}; exit 0; fi`,
    'n=$(wc -l < "$f")',
    'if [ -n "$(tail -c 1 "$f")" ]; then n=$((n+1)); fi',
    `printf '%s%s\\n' ${shellQuote(META_PREFIX)} "$n"`,
    `sed -n '${from},${to}p;${to + 1}q' "$f" | head -c ${MAX_READ_BYTES}`,
  ].join('\n')
}

export function formatSlice(stdout: string, filePath: string, offset: number): string {
  const newline = stdout.indexOf('\n')
  const head = newline === -1 ? stdout : stdout.slice(0, newline)
  if (head.trim() === NOT_FOUND) throw new Error(`File not found: ${filePath}`)
  if (head.trim() === NOT_REGULAR) throw new Error(`Not a regular file: ${filePath}`)
  if (!head.startsWith(META_PREFIX)) throw new Error(`Could not read ${filePath}: ${stdout.slice(0, 500)}`)

  const total = Number(head.slice(META_PREFIX.length).trim())
  const body = newline === -1 ? '' : stdout.slice(newline + 1)
  const clipped = Buffer.byteLength(body, 'utf8') >= MAX_READ_BYTES
  return formatFile(body, offset, Number.isFinite(total) ? total : undefined, clipped)
}

/**
 * Numbers an already-sliced body. `total` is the file's real line count, used
 * only for the footer; `body` never holds more than the requested slice.
 */
export function formatFile(body: string, offset: number, total?: number, clipped = false): string {
  const lines = body.split('\n')
  // A trailing newline leaves an empty last element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) {
    if (total !== undefined && offset > 0 && offset >= total) {
      return `(offset ${offset} is past the end of the file, which has ${total} lines)`
    }
    return '(empty file)'
  }

  const output =
    '<file>\n' +
    lines
      .map((line, index) => {
        const number = String(offset + index + 1).padStart(5, '0')
        const shown =
          line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… (line truncated)` : line
        return `${number}| ${shown}`
      })
      .join('\n') +
    '\n</file>'

  const notes: string[] = []
  const end = offset + lines.length
  if (total !== undefined && end < total) {
    notes.push(`showing lines ${offset + 1}-${end} of ${total}; read on with offset=${end}`)
  }
  if (clipped) {
    notes.push(`the slice hit the ${MAX_READ_BYTES}-byte ceiling and was cut; lower limit`)
  }
  return notes.length > 0 ? `${output}\n\n(${notes.join('; ')})` : output
}
