import { z } from 'zod'
import { posix } from 'path'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

/**
 * Replacement for OpenCode's built-in apply_patch tool. The built-in edits
 * files on the LOCAL machine; every other file tool here routes to the
 * sandbox, so leaving it in place would let the agent bypass the sandbox and
 * modify the host project directly. This tool shadows it by name and applies
 * the same patch format (the "*** Begin Patch" envelope with Add/Update/
 * Delete File sections) inside the Tensorlake sandbox instead.
 */

type HunkPart = { kind: 'ctx' | 'del' | 'add'; line: string }

type Hunk = {
  anchor?: string
  // The hunk body in order: 'ctx' and 'del' lines must appear consecutively
  // in the file; 'add' lines are inserted in their place alongside the
  // (preserved) context lines.
  parts: HunkPart[]
}

type PatchOp =
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; hunks: Hunk[] }

export function parsePatch(patchText: string): PatchOp[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (lines[i]?.trim() !== '*** Begin Patch') {
    throw new Error(`apply_patch: patch must start with '*** Begin Patch'`)
  }
  i++
  const ops: PatchOp[] = []
  let sawEnd = false
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '*** End Patch') {
      sawEnd = true
      break
    }
    let m: RegExpMatchArray | null
    if ((m = line.match(/^\*\*\* Add File: (.+)$/))) {
      const path = m[1].trim()
      i++
      const content: string[] = []
      while (i < lines.length && !lines[i].startsWith('***')) {
        const l = lines[i]
        // Every content line must carry a '+', but tolerate a bare empty
        // line: models emit those for blank lines often enough.
        if (l.startsWith('+')) content.push(l.slice(1))
        else if (l === '') content.push('')
        else throw new Error(`apply_patch: in 'Add File: ${path}' every line must start with '+'`)
        i++
      }
      ops.push({ type: 'add', path, lines: content })
    } else if ((m = line.match(/^\*\*\* Delete File: (.+)$/))) {
      ops.push({ type: 'delete', path: m[1].trim() })
      i++
    } else if ((m = line.match(/^\*\*\* Update File: (.+)$/))) {
      const path = m[1].trim()
      i++
      let movePath: string | undefined
      const mv = lines[i]?.match(/^\*\*\* Move to: (.+)$/)
      if (mv) {
        movePath = mv[1].trim()
        i++
      }
      const hunks: Hunk[] = []
      let cur: Hunk = { parts: [] }
      const flush = () => {
        if (cur.anchor !== undefined || cur.parts.length > 0) hunks.push(cur)
        cur = { parts: [] }
      }
      while (i < lines.length && (!lines[i].startsWith('***') || lines[i].trim() === '*** End of File')) {
        const l = lines[i]
        if (l.trim() === '*** End of File') {
          // Marks a hunk anchored at EOF; the apply step already falls back
          // to appending at the end, so the marker itself needs no state.
        } else if (l.startsWith('@@')) {
          flush()
          const anchor = l.slice(2).trim()
          if (anchor) cur.anchor = anchor
        } else if (l.startsWith('+')) {
          cur.parts.push({ kind: 'add', line: l.slice(1) })
        } else if (l.startsWith('-')) {
          cur.parts.push({ kind: 'del', line: l.slice(1) })
        } else if (l.startsWith(' ')) {
          cur.parts.push({ kind: 'ctx', line: l.slice(1) })
        } else if (l === '') {
          // A blank context line whose leading space was dropped.
          cur.parts.push({ kind: 'ctx', line: '' })
        } else {
          throw new Error(`apply_patch: in 'Update File: ${path}' unexpected line: ${l}`)
        }
        i++
      }
      flush()
      if (hunks.length === 0) throw new Error(`apply_patch: 'Update File: ${path}' has no hunks`)
      ops.push({ type: 'update', path, movePath, hunks })
    } else {
      throw new Error(`apply_patch: unexpected line in patch: ${line}`)
    }
  }
  if (!sawEnd) throw new Error(`apply_patch: patch must end with '*** End Patch'`)
  if (ops.length === 0) throw new Error('apply_patch: patch contains no file operations')
  return ops
}

// Find `seq` as a run of consecutive lines at index >= from. Three passes of
// decreasing strictness — exact, ignoring trailing whitespace, ignoring all
// edge whitespace — so hunks survive the whitespace drift models introduce.
function findSequence(lines: string[], seq: string[], from: number): number {
  const canons = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]
  for (const canon of canons) {
    for (let at = from; at + seq.length <= lines.length; at++) {
      let ok = true
      for (let j = 0; j < seq.length; j++) {
        if (canon(lines[at + j]) !== canon(seq[j])) {
          ok = false
          break
        }
      }
      if (ok) return at
    }
  }
  return -1
}

export function applyHunks(content: string, hunks: Hunk[], path: string): string {
  const lines = content.split('\n')
  let cursor = 0
  for (const hunk of hunks) {
    let anchorFound = false
    if (hunk.anchor !== undefined) {
      const at = findSequence(lines, [hunk.anchor], cursor)
      if (at >= 0) {
        cursor = at + 1
        anchorFound = true
      }
      // A missed anchor is not fatal: it only narrows the search, and the
      // context match below still validates the hunk.
    }
    const old = hunk.parts.filter((p) => p.kind !== 'add').map((p) => p.line)
    if (old.length === 0) {
      // Pure insertion. After a found anchor it goes right there; otherwise
      // it appends at EOF, before the final empty element that represents
      // the file's trailing newline.
      const added = hunk.parts.map((p) => p.line)
      let at = lines.length
      if (anchorFound) at = cursor
      else if (lines.length > 0 && lines[lines.length - 1] === '') at = lines.length - 1
      lines.splice(at, 0, ...added)
      cursor = at + added.length
      continue
    }
    const at = findSequence(lines, old, cursor)
    if (at < 0) {
      throw new Error(
        `apply_patch: context not found in ${path} near: ${old[0]}\n` +
          `The file in the sandbox may differ from what you expect — read it and retry, or use the edit tool.`,
      )
    }
    // Build the replacement, keeping the file's own context lines: on a
    // whitespace-fuzzy match the patch's copy of a context line may differ
    // from the file, and re-emitting the patch's copy would churn it.
    const replacement: string[] = []
    let matched = at
    for (const part of hunk.parts) {
      if (part.kind === 'ctx') replacement.push(lines[matched++])
      else if (part.kind === 'del') matched++
      else replacement.push(part.line)
    }
    lines.splice(at, old.length, ...replacement)
    cursor = at + replacement.length
  }
  return lines.join('\n')
}

export const applyPatchTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Applies a patch to files in the Tensorlake sandbox. The patch uses the standard envelope: ' +
    "'*** Begin Patch', then one or more '*** Add File: path' / '*** Update File: path' / " +
    "'*** Delete File: path' sections, then '*** End Patch'. Update sections contain hunks of " +
    "' ' context, '-' removed, and '+' added lines, optionally preceded by an '@@ anchor' line. " +
    'Relative paths resolve against the project directory in the sandbox.',
  args: {
    patchText: z.string().describe('The full patch text describing add, update, and delete operations'),
  },
  async execute(args: { patchText: string }, ctx: ToolContext) {
    const ops = parsePatch(args.patchText)
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const client = sessionManager.getClient()
    const projectDir = sessionManager.projectDir(worktree)
    const resolve = (p: string) => (p.startsWith('/') ? posix.normalize(p) : posix.join(projectDir, p))

    // Plan every write before performing any, so a bad hunk in the third
    // file cannot leave the first two half-applied.
    type Write = { path: string; data: Buffer; note: string; removeAfter?: string }
    type Remove = { path: string; note: string }
    const writes: Write[] = []
    const removes: Remove[] = []
    for (const op of ops) {
      const path = resolve(op.path)
      if (op.type === 'add') {
        writes.push({ path, data: Buffer.from(op.lines.join('\n') + '\n'), note: `A ${op.path}` })
      } else if (op.type === 'delete') {
        removes.push({ path, note: `D ${op.path}` })
      } else {
        const buffer = await client.readFile(sandboxId, path)
        const updated = applyHunks(new TextDecoder().decode(buffer), op.hunks, op.path)
        const dest = op.movePath ? resolve(op.movePath) : path
        writes.push({
          path: dest,
          data: Buffer.from(updated),
          note: op.movePath ? `M ${op.path} -> ${op.movePath}` : `M ${op.path}`,
          removeAfter: dest !== path ? path : undefined,
        })
      }
    }

    const results: string[] = []
    for (const w of writes) {
      const dir = posix.dirname(w.path)
      if (dir && dir !== '/') {
        await client.executeCommand(sandboxId, `mkdir -p ${shellQuote(dir)}`, '/').catch(() => {})
      }
      await client.writeFile(sandboxId, w.path, w.data)
      if (w.removeAfter) {
        await client.executeCommand(sandboxId, `rm -f -- ${shellQuote(w.removeAfter)}`, '/').catch(() => {})
      }
      results.push(w.note)
    }
    for (const r of removes) {
      const rm = await client.executeCommand(sandboxId, `rm -- ${shellQuote(r.path)}`, '/')
      if (rm.exitCode !== 0) {
        results.push(`FAILED ${r.note}: ${rm.stderr || rm.stdout}`)
        continue
      }
      results.push(r.note)
    }
    return `Applied patch in the Tensorlake sandbox:\n${results.join('\n')}`
  },
})
