/**
 * Runs the apply_patch tool against a fake sandbox: every shell script the
 * tool sends is executed by the local `sh` in a temp directory, so the
 * backup/commit/rollback logic is exercised for real without a Tensorlake key.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPatchTool } from '../.opencode/plugin/tensorlake/tools/apply-patch.js'

let root: string
let project: string

// Executes the tool's scripts locally. Absolute paths in the scripts are the
// sandbox's; we substitute `/tmp/workspace` with the project temp dir. The
// staging directory (`/tmp/apply_patch.*`) is created for real by mktemp and
// removed by the tool's own cleanup.
function fakeClient() {
  const map = (s: string) => s.split('/tmp/workspace').join(project)
  return {
    async executeCommand(_id: string, command: string) {
      try {
        const stdout = execFileSync('sh', ['-c', map(command)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { exitCode: 0, stdout, stderr: '' }
      } catch (err: any) {
        return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
      }
    },
    async readFileBounded(_id: string, path: string, max: number) {
      const buf = readFileSync(map(path))
      if (buf.length > max) throw new Error('too big')
      return buf
    },
    async writeFile(_id: string, path: string, data: Buffer) {
      writeFileSync(map(path), data)
    },
  }
}

function makeTool(client = fakeClient()) {
  const sessionManager = {
    getSandbox: async () => ({ sandboxId: 'sb' }),
    getClient: () => client,
    projectDir: () => '/tmp/workspace',
  }
  return applyPatchTool(sessionManager as any, 'proj', '/local/worktree', {} as any)
}

const run = (patch: string) => makeTool().execute({ patchText: patch }, { sessionID: 's1' } as any)
const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
const read = (rel: string) => readFileSync(join(project, rel), 'utf-8')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apply-patch-'))
  project = join(root, 'workspace')
  mkdirSync(project)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('add + update + delete + move in one patch', async () => {
  writeFileSync(join(project, 'b.txt'), 'keep\nold\n')
  writeFileSync(join(project, 'd.txt'), 'bye\n')
  const out = await run(
    wrap(
      [
        '*** Add File: sub/dir/a.txt',
        '+hello',
        '*** Update File: b.txt',
        '*** Move to: c.txt',
        ' keep',
        '-old',
        '+new',
        '*** Delete File: d.txt',
      ].join('\n'),
    ),
  )
  assert.match(out, /A sub\/dir\/a\.txt/)
  assert.match(out, /M b\.txt -> c\.txt/)
  assert.match(out, /D d\.txt/)
  assert.equal(read('sub/dir/a.txt'), 'hello\n')
  assert.equal(read('c.txt'), 'keep\nnew\n')
  assert.equal(existsSync(join(project, 'b.txt')), false)
  assert.equal(existsSync(join(project, 'd.txt')), false)
  // Staging directory cleaned up.
  assert.deepEqual(readdirSync('/tmp').filter((n) => n.startsWith('apply_patch.')), [])
})

test('Add File onto an existing path is refused, nothing changes', async () => {
  writeFileSync(join(project, 'a.txt'), 'orig\n')
  await assert.rejects(run(wrap('*** Add File: a.txt\n+x')), /already exists/)
  assert.equal(read('a.txt'), 'orig\n')
})

test('Update File on a missing path is refused', async () => {
  await assert.rejects(run(wrap('*** Update File: nope.txt\n-a\n+b')), /ENOENT|does not exist/)
})

test('Delete File on a missing path is refused', async () => {
  await assert.rejects(run(wrap('*** Delete File: nope.txt')), /does not exist in the sandbox/)
})

test('Update File on a directory is refused', async () => {
  mkdirSync(join(project, 'dir'))
  await assert.rejects(run(wrap('*** Delete File: dir')), /is a directory/)
})

test('hunk context mismatch: error, no files changed', async () => {
  writeFileSync(join(project, 'a.txt'), 'real\n')
  writeFileSync(join(project, 'b.txt'), 'b\n')
  await assert.rejects(
    run(wrap('*** Update File: b.txt\n-b\n+B\n*** Update File: a.txt\n-imagined\n+x')),
    /context not found in a\.txt/,
  )
  assert.equal(read('a.txt'), 'real\n')
  assert.equal(read('b.txt'), 'b\n')
})

test('same path touched twice is refused', async () => {
  writeFileSync(join(project, 'a.txt'), 'a\n')
  await assert.rejects(run(wrap('*** Update File: a.txt\n-a\n+b\n*** Delete File: a.txt')), /touched twice/)
  assert.equal(read('a.txt'), 'a\n')
})

test('Move to an existing destination is refused', async () => {
  writeFileSync(join(project, 'a.txt'), 'a\n')
  writeFileSync(join(project, 'b.txt'), 'b\n')
  await assert.rejects(run(wrap('*** Update File: a.txt\n*** Move to: b.txt\n-a\n+A')), /already exists/)
  assert.equal(read('a.txt'), 'a\n')
  assert.equal(read('b.txt'), 'b\n')
})

test('commit failure rolls every file back', async () => {
  writeFileSync(join(project, 'a.txt'), 'a\n')
  writeFileSync(join(project, 'b.txt'), 'b\n')
  // Make the second write fail: turn its target into a read-only directory
  // path so `cat > b.txt` cannot happen. Steps run in patch order, so a.txt
  // is already rewritten and must be restored.
  rmSync(join(project, 'b.txt'))
  mkdirSync(join(project, 'b.txt'))
  const client = fakeClient()
  // Bypass the phase-2 probe for b.txt by pretending it is a plain file.
  const orig = client.executeCommand.bind(client)
  client.executeCommand = async (id, cmd) => {
    if (cmd.startsWith('if [ -d')) return { exitCode: 0, stdout: 'file\nfile\n', stderr: '' }
    return orig(id, cmd)
  }
  const origRead = client.readFileBounded.bind(client)
  client.readFileBounded = async (id, path, max) => (path.endsWith('b.txt') ? Buffer.from('b\n') : origRead(id, path, max))
  const tool = applyPatchTool(
    { getSandbox: async () => ({ sandboxId: 'sb' }), getClient: () => client, projectDir: () => '/tmp/workspace' } as any,
    'proj',
    '/w',
    {} as any,
  )
  await assert.rejects(
    tool.execute(
      { patchText: wrap('*** Update File: a.txt\n-a\n+A\n*** Update File: b.txt\n-b\n+B') },
      { sessionID: 's' } as any,
    ),
    /No files were changed/,
  )
  assert.equal(read('a.txt'), 'a\n', 'a.txt was restored from backup')
})

test('absolute paths are used as-is; relative paths resolve under the project dir', async () => {
  const other = join(root, 'elsewhere')
  mkdirSync(other)
  // The fake maps /tmp/workspace only, so use an absolute path inside it.
  await run(wrap('*** Add File: /tmp/workspace/abs.txt\n+abs\n*** Add File: rel.txt\n+rel'))
  assert.equal(read('abs.txt'), 'abs\n')
  assert.equal(read('rel.txt'), 'rel\n')
})

test('an existing file keeps its mode after update', async () => {
  const p = join(project, 'run.sh')
  writeFileSync(p, '#!/bin/sh\necho 1\n', { mode: 0o755 })
  await run(wrap('*** Update File: run.sh\n-echo 1\n+echo 2'))
  const mode = (statSync(p).mode & 0o777).toString(8)
  assert.equal(mode, '755')
  assert.equal(read('run.sh'), '#!/bin/sh\necho 2\n')
})
