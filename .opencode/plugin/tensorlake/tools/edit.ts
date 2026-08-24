import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

export type EditSpec = { oldString: string; newString: string; replaceAll?: boolean }

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count++
    // Advance past the match so overlapping candidates are not double counted,
    // which matches how the replacement below consumes the string.
    from = at + needle.length
  }
}

/**
 * Applies one edit to `content` and returns the new content.
 *
 * Every failure mode is an error rather than a silent no-op: a plain
 * String.replace() would report success after changing nothing (missing
 * oldString), quietly edit only the first of several matches, or insert text
 * at offset 0 for an empty oldString. It would also expand `$&` / `$1` /
 * '$`' in the replacement, corrupting any newString that contains them.
 */
export function applyEdit(content: string, edit: EditSpec, label: string): string {
  if (edit.oldString === '') {
    throw new Error(`${label}: oldString must not be empty; use the write tool to create or overwrite a file`)
  }
  if (edit.oldString === edit.newString) {
    throw new Error(`${label}: oldString and newString are identical, so the edit would do nothing`)
  }
  const matches = countOccurrences(content, edit.oldString)
  if (matches === 0) {
    throw new Error(`${label}: oldString was not found. The text must match the file exactly, including whitespace.`)
  }
  if (matches > 1 && !edit.replaceAll) {
    throw new Error(
      `${label}: oldString matches ${matches} times. Add more surrounding context to make it unique, or set replaceAll to true.`,
    )
  }
  // split/join replaces literally; String.replace would expand $-patterns.
  if (edit.replaceAll) return content.split(edit.oldString).join(edit.newString)
  const at = content.indexOf(edit.oldString)
  return content.slice(0, at) + edit.newString + content.slice(at + edit.oldString.length)
}

export const editTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Replaces a string in a file in the Tensorlake sandbox. oldString must match exactly once unless replaceAll is set.',
  args: {
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one match'),
  },
  async execute(
    args: { filePath: string; oldString: string; newString: string; replaceAll?: boolean },
    ctx: ToolContext,
  ) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const client = sessionManager.getClient()
    const buffer = await client.readFile(sandboxId, args.filePath)
    const content = new TextDecoder().decode(buffer)
    const newContent = applyEdit(content, args, `edit ${args.filePath}`)
    await client.writeFile(sandboxId, args.filePath, Buffer.from(newContent))
    const replaced = args.replaceAll ? countOccurrences(content, args.oldString) : 1
    return `Edited ${args.filePath} (${replaced} replacement${replaced === 1 ? '' : 's'})`
  },
})
