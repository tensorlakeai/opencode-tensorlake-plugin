import { z } from 'zod'
import { posix } from 'path'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'
import { shellQuote } from '../core/shell.js'

// Whole-file edits load the file into this process, so refuse the ones big
// enough to hurt it. Anything larger belongs in a bash command.
const MAX_EDIT_BYTES = 10 * 1024 * 1024

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
  // The hunk's context must match at the very end of the file
  // ('*** End of File' marker).
  eof?: boolean
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
          // The hunk before the marker must match at the end of the file.
          cur.eof = true
          flush()
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

// Comparison passes of decreasing strictness — exact, ignoring trailing
// whitespace, ignoring all edge whitespace — so hunks survive the whitespace
// drift models introduce.
const CANONS = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]

function matchesAt(lines: string[], seq: string[], at: number, canon: (s: string) => string): boolean {
  if (at < 0 || at + seq.length > lines.length) return false
  for (let j = 0; j < seq.length; j++) {
    if (canon(lines[at + j]) !== canon(seq[j])) return false
  }
  return true
}

// Find `seq` as a run of consecutive lines at index >= from.
function findSequence(lines: string[], seq: string[], from: number): number {
  for (const canon of CANONS) {
    for (let at = from; at + seq.length <= lines.length; at++) {
      if (matchesAt(lines, seq, at, canon)) return at
    }
  }
  return -1
}

// Find `seq` only where it ends the file. A file that ends with a newline
// splits to a trailing '' element the patch's context never includes, so both
// tail positions count as EOF.
function findSequenceAtEof(lines: string[], seq: string[]): number {
  const starts =
    lines.length > 0 && lines[lines.length - 1] === ''
      ? [lines.length - 1 - seq.length, lines.length - seq.length]
      : [lines.length - seq.length]
  for (const canon of CANONS) {
    for (const at of starts) {
      if (matchesAt(lines, seq, at, canon)) return at
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
      if (anchorFound && !hunk.eof) at = cursor
      else if (lines.length > 0 && lines[lines.length - 1] === '') at = lines.length - 1
      lines.splice(at, 0, ...added)
      cursor = at + added.length
      continue
    }
    // An EOF hunk must match where the file ends; fall back to a normal scan
    // only if no tail match exists, so a stray marker cannot make the whole
    // patch fail.
    let at = hunk.eof ? findSequenceAtEof(lines, old) : -1
    if (at < 0) at = findSequence(lines, old, cursor)
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
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, pluginCtx)
    const client = sessionManager.getClient()
    const projectDir = sessionManager.projectDir()
    const resolve = (p: string) => (p.startsWith('/') ? posix.normalize(p) : posix.join(projectDir, p))

    // The patch is applied in three phases so it is all-or-nothing:
    //   1. plan   — parse, read sources, run every hunk in memory
    //   2. verify — one probe of the sandbox checks that Add targets are
    //               absent and Update/Delete targets are existing files
    //   3. commit — one shell script backs up each target, makes every
    //               change, and restores the backups if any step fails
    // `modeFrom` names an existing file whose permissions the new file copies
    // (a Move keeps the mode of its source).
    type Step = { kind: 'write'; path: string; data: Buffer; modeFrom?: string } | { kind: 'remove'; path: string }
    const steps: Step[] = []
    const notes: string[] = []
    const requireAbsent: string[] = []
    const requireFile: string[] = []

    // Each path may be touched once only. Two operations on one path make the
    // outcome depend on section order and leave the rollback ambiguous.
    const claimed = new Map<string, string>()
    const claim = (path: string, what: string) => {
      const prev = claimed.get(path)
      if (prev) throw new Error(`apply_patch: ${path} is touched twice by this patch (${prev}, then ${what})`)
      claimed.set(path, what)
    }

    for (const op of ops) {
      const path = resolve(op.path)
      if (op.type === 'add') {
        claim(path, `Add File: ${op.path}`)
        requireAbsent.push(path)
        steps.push({ kind: 'write', path, data: Buffer.from(op.lines.join('\n') + '\n') })
        notes.push(`A ${op.path}`)
      } else if (op.type === 'delete') {
        claim(path, `Delete File: ${op.path}`)
        requireFile.push(path)
        steps.push({ kind: 'remove', path })
        notes.push(`D ${op.path}`)
      } else {
        claim(path, `Update File: ${op.path}`)
        requireFile.push(path)
        const buffer = await client.readFileBounded(sandboxId, path, MAX_EDIT_BYTES)
        const updated = applyHunks(new TextDecoder().decode(buffer), op.hunks, op.path)
        const dest = op.movePath ? resolve(op.movePath) : path
        if (dest !== path) {
          claim(dest, `Move to: ${op.movePath}`)
          requireAbsent.push(dest)
        }
        steps.push({ kind: 'write', path: dest, data: Buffer.from(updated), ...(dest !== path ? { modeFrom: path } : {}) })
        if (dest !== path) steps.push({ kind: 'remove', path })
        notes.push(op.movePath ? `M ${op.path} -> ${op.movePath}` : `M ${op.path}`)
      }
    }

    // Phase 2: one round trip classifies every target path.
    const probe = [...requireAbsent, ...requireFile]
    const probeScript = probe
      .map(
        (p) =>
          `if [ -d ${shellQuote(p)} ]; then echo dir; ` +
          `elif [ -e ${shellQuote(p)} ] || [ -L ${shellQuote(p)} ]; then echo file; else echo none; fi`,
      )
      .join('\n')
    const probed = await client.executeCommand(sandboxId, probeScript, '/')
    if (probed.exitCode !== 0) {
      throw new Error(`apply_patch: could not inspect the target paths: ${probed.stderr || probed.stdout}`)
    }
    const kinds = probed.stdout.split('\n').map((s) => s.trim()).filter((s) => s !== '')
    if (kinds.length !== probe.length) {
      throw new Error(`apply_patch: could not inspect the target paths: unexpected probe output`)
    }
    for (let k = 0; k < probe.length; k++) {
      const path = probe[k]
      if (kinds[k] === 'dir') throw new Error(`apply_patch: ${path} is a directory, not a file`)
      if (k < requireAbsent.length) {
        if (kinds[k] !== 'none') {
          throw new Error(
            `apply_patch: ${path} already exists — use '*** Update File' instead of adding or moving onto it`,
          )
        }
      } else if (kinds[k] === 'none') {
        throw new Error(`apply_patch: ${path} does not exist in the sandbox`)
      }
    }

    // Phase 3. New content goes to a staging directory first: those writes
    // touch nothing in the project tree, so a failure here changes nothing.
    const made = await client.executeCommand(sandboxId, 'mktemp -d /tmp/apply_patch.XXXXXXXX', '/')
    const stageDir = made.stdout.trim()
    if (made.exitCode !== 0 || !stageDir.startsWith('/tmp/apply_patch.')) {
      throw new Error(`apply_patch: could not create a staging directory: ${made.stderr || made.stdout}`)
    }
    const cleanup = () => client.executeCommand(sandboxId, `rm -rf -- ${shellQuote(stageDir)}`, '/').catch(() => {})
    const backupDir = `${stageDir}/backup`
    const newDirs = `${stageDir}/newdirs`
    const stagePath = (index: number) => `${stageDir}/w${index}`

    let commit
    try {
      for (let k = 0; k < steps.length; k++) {
        const step = steps[k]
        if (step.kind === 'write') await client.writeFile(sandboxId, stagePath(k), step.data)
      }

      const targets = steps.map((s) => s.path)
      const backupPath = (index: number) => `${backupDir}/${index}`
      // Restoring every target is safe even for the ones the run never
      // reached: a backup holds the pre-run content, and a missing backup
      // means the path did not exist before the run.
      const restore = targets
        .map(
          (p, k) =>
            `  if [ -e ${shellQuote(backupPath(k))} ]; then ` +
            `mkdir -p ${shellQuote(posix.dirname(p))} && cp -p -- ${shellQuote(backupPath(k))} ${shellQuote(p)} || ` +
            `echo "apply_patch: ROLLBACK FAILED for ${p}" >&2; ` +
            `else rm -f -- ${shellQuote(p)}; fi`,
        )
        .reverse()
      const lines: string[] = [
        `mkdir -p ${shellQuote(backupDir)} || exit 1`,
        'fail() {',
        ...restore,
        // Directories this run created, deepest first. Only those: an
        // unconditional rmdir of every parent would remove the project
        // directory itself when the patch adds the first file to an empty one.
        `  if [ -f ${shellQuote(newDirs)} ]; then sort -r ${shellQuote(newDirs)} | ` +
          `while IFS= read -r d; do rmdir "$d" 2>/dev/null; done; fi`,
        '  printf "%s\\n" "$1" >&2',
        '  exit 1',
        '}',
      ]
      for (let k = 0; k < targets.length; k++) {
        const p = targets[k]
        lines.push(
          `if [ -e ${shellQuote(p)} ]; then cp -p -- ${shellQuote(p)} ${shellQuote(backupPath(k))} || ` +
            `fail "apply_patch: could not back up ${p}"; fi`,
        )
      }
      for (let k = 0; k < steps.length; k++) {
        const step = steps[k]
        if (step.kind === 'write') {
          const dir = posix.dirname(step.path)
          if (dir && dir !== '/') {
            lines.push(
              // Record every ancestor that does not exist yet, not only the
              // leaf: mkdir -p creates all of them, and rollback must remove
              // all of them.
              `d=${shellQuote(dir)}; while [ "$d" != / ] && [ "$d" != . ] && [ ! -d "$d" ]; do ` +
                `printf "%s\\n" "$d" >> ${shellQuote(newDirs)}; d=$(dirname "$d"); done`,
              `mkdir -p ${shellQuote(dir)} || fail "apply_patch: could not create ${dir}"`,
            )
          }
          if (step.modeFrom) {
            // A moved file keeps the mode of its source: create the
            // destination as a copy of the source before writing the content.
            lines.push(
              `cp -p -- ${shellQuote(step.modeFrom)} ${shellQuote(step.path)} || ` +
                `fail "apply_patch: could not create ${step.path}"`,
            )
          }
          // Redirect rather than copy so an existing file keeps its mode.
          lines.push(
            `cat ${shellQuote(stagePath(k))} > ${shellQuote(step.path)} || ` +
              `fail "apply_patch: could not write ${step.path}"`,
          )
        } else {
          lines.push(`rm -- ${shellQuote(step.path)} || fail "apply_patch: could not delete ${step.path}"`)
        }
      }
      lines.push('exit 0')
      commit = await client.executeCommand(sandboxId, lines.join('\n'), '/')
    } catch (error) {
      await cleanup()
      throw error
    }

    if (commit.exitCode !== 0) {
      const detail = (commit.stderr || commit.stdout).trim()
      if (detail.includes('ROLLBACK FAILED')) {
        // Leave the staging directory in place: it holds the only copy of the
        // original files.
        throw new Error(`${detail}\nBackups of the original files are in ${backupDir}.`)
      }
      await cleanup()
      throw new Error(`${detail || 'apply_patch: the patch could not be applied'}\nNo files were changed.`)
    }
    await cleanup()
    return `Applied patch in the Tensorlake sandbox:\n${notes.join('\n')}`
  },
})
