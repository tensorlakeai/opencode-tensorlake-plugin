import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { applyEdit, type EditSpec } from './edit.js'

// Whole-file edits load the file into this process, so refuse the ones big
// enough to hurt it. Anything larger belongs in a bash command.
const MAX_EDIT_BYTES = 10 * 1024 * 1024

/**
 * Applies several edits to one file atomically. Each edit runs against the
 * result of the previous one, and the file is written only after all of them
 * succeed, so a failure in edit 3 leaves the file untouched instead of half
 * edited.
 */
export const multiEditTool = (
  sessionManager: TensorlakeSessionManager,
  pluginCtx: PluginInput,
) => ({
  description:
    'Applies several string replacements to one file in the Tensorlake sandbox, in order and atomically. ' +
    'If any edit fails, the file is left unchanged. Each oldString must match exactly once unless replaceAll is set.',
  args: {
    filePath: z.string(),
    edits: z
      .array(
        z.object({
          oldString: z.string(),
          newString: z.string(),
          replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one match'),
        }),
      )
      .min(1)
      .describe('Edits applied in order, each against the result of the previous one'),
  },
  async execute(args: { filePath: string; edits: EditSpec[] }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, pluginCtx)
    const client = sessionManager.getClient()
    const buffer = await client.readFileBounded(sandboxId, args.filePath, MAX_EDIT_BYTES)
    const original = new TextDecoder().decode(buffer)
    let content = original
    args.edits.forEach((edit, i) => {
      content = applyEdit(content, edit, `multiedit ${args.filePath}: edit ${i + 1}/${args.edits.length}`)
    })
    if (content === original) return `No change to ${args.filePath}`
    await client.writeFile(sandboxId, args.filePath, Buffer.from(content))
    return `Edited ${args.filePath} (${args.edits.length} edit${args.edits.length === 1 ? '' : 's'})`
  },
})
