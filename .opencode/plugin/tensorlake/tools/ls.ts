import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

const MAX_ENTRIES = 1000

export const lsTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: `Lists files in a directory in the Tensorlake sandbox, at most ${MAX_ENTRIES} entries. Directories end in "/".`,
  args: {
    dirPath: z.string().optional(),
  },
  async execute(args: { dirPath?: string }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const path = args.dirPath ?? sessionManager.projectDir(worktree)
    // `ls -Ap` already marks directories with a trailing slash, and the cut
    // happens in the sandbox, so a directory with a million entries cannot
    // flood this process the way listDirectory would.
    const cmd = `ls -Ap -- ${shellQuote(path)} | head -n ${MAX_ENTRIES + 1}`
    const result = await sessionManager.getClient().executeCommand(sandboxId, cmd, '/')

    const entries = result.stdout.split('\n').filter((line) => line !== '')
    // `head` swallows the exit code of `ls`, so a failure shows up only as
    // stderr with no listing behind it.
    if (entries.length === 0) {
      if (result.stderr.trim()) throw new Error(`Could not list ${path}: ${result.stderr.trim()}`)
      return '(empty directory)'
    }
    const shown = entries.slice(0, MAX_ENTRIES)
    return entries.length > shown.length
      ? `${shown.join('\n')}\n\n(showing the first ${MAX_ENTRIES} entries)`
      : shown.join('\n')
  },
})
