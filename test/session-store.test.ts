import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { SessionStore, storageKey } from '../.opencode/plugin/tensorlake/core/session-store.js'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'session-store-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const info = (id: string) => ({ sandboxId: id, created: 1, lastAccessed: 1 })

test('round trip: update then read', () => {
  const store = new SessionStore(dir)
  store.update('proj', '/wt', (d) => {
    d.sessions.s1 = info('sb-1')
  })
  const data = store.read('proj')
  assert.equal(data?.worktree, '/wt')
  assert.equal(data?.sessions.s1.sandboxId, 'sb-1')
  assert.deepEqual(readdirSync(dir), ['proj.json'], 'no lock or temp files left behind')
})

test('update keeps other sessions and honours mutate() === false', () => {
  const store = new SessionStore(dir)
  store.update('proj', '/wt', (d) => void (d.sessions.a = info('sb-a')))
  store.update('proj', '/wt', (d) => void (d.sessions.b = info('sb-b')))
  store.update('proj', '/wt', (d) => {
    d.sessions.a = info('CLOBBER')
    return false
  })
  const data = store.read('proj')!
  assert.deepEqual(Object.keys(data.sessions).sort(), ['a', 'b'])
  assert.equal(data.sessions.a.sandboxId, 'sb-a')
})

test('missing file reads as null', () => {
  assert.equal(new SessionStore(dir).read('nothing'), null)
})

test('unparseable file is quarantined, not deleted', () => {
  writeFileSync(join(dir, 'proj.json'), '{ not json')
  const store = new SessionStore(dir)
  assert.equal(store.read('proj'), null)
  const files = readdirSync(dir)
  assert.equal(files.length, 1)
  assert.match(files[0], /^proj\.json\.corrupt-\d+$/)
  assert.equal(readFileSync(join(dir, files[0]), 'utf-8'), '{ not json')
  // A following update starts fresh instead of failing.
  store.update('proj', '/wt', (d) => void (d.sessions.x = info('sb-x')))
  assert.equal(store.read('proj')?.sessions.x.sandboxId, 'sb-x')
})

test('a JSON file without a sessions object is also quarantined', () => {
  writeFileSync(join(dir, 'proj.json'), JSON.stringify({ projectId: 'proj' }))
  assert.equal(new SessionStore(dir).read('proj'), null)
  assert.ok(readdirSync(dir).some((f) => f.includes('.corrupt-')))
})

test('a lock held by a live process blocks the write (and is left alone)', () => {
  const store = new SessionStore(dir)
  const lock = join(dir, 'proj.json.lock')
  writeFileSync(lock, `${process.pid}`) // this process is alive
  const t0 = Date.now()
  store.update('proj', '/wt', (d) => void (d.sessions.x = info('sb-x')))
  const waited = Date.now() - t0
  assert.ok(waited >= 5_000, `waited ${waited}ms for the lock`)
  assert.equal(existsSync(join(dir, 'proj.json')), false, 'write skipped')
  assert.equal(existsSync(lock), true, 'someone else’s lock is not removed')
})

test('a stale lock from a dead process is broken', () => {
  const store = new SessionStore(dir)
  const lock = join(dir, 'proj.json.lock')
  // Spawn a process, let it exit, and use its PID: definitely dead.
  const deadPid = execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf-8' }).trim()
  writeFileSync(lock, deadPid)
  const old = new Date(Date.now() - 10_000)
  utimesSync(lock, old, old)
  store.update('proj', '/wt', (d) => void (d.sessions.x = info('sb-x')))
  assert.equal(store.read('proj')?.sessions.x.sandboxId, 'sb-x')
  assert.equal(existsSync(lock), false)
})

test('two processes updating the same file lose nothing', () => {
  const script = `
    import { SessionStore } from ${JSON.stringify(join(process.cwd(), '.opencode/plugin/tensorlake/core/session-store.ts'))}
    const [dir, tag, n] = process.argv.slice(2)
    const store = new SessionStore(dir)
    for (let i = 0; i < Number(n); i++) {
      store.update('proj', '/wt', (d) => { d.sessions[tag + i] = { sandboxId: tag, created: 1, lastAccessed: 1 } })
    }
  `
  const file = join(dir, 'writer.mts')
  writeFileSync(file, script)
  const tsx = join(process.cwd(), 'node_modules/.bin/tsx')
  const procs = ['A', 'B', 'C'].map((tag) => spawn(tsx, [file, dir, tag, '40'], { stdio: 'inherit' }))
  const codes = Promise.all(procs.map((p) => new Promise<number>((r) => p.on('exit', (c) => r(c ?? 1)))))
  return codes.then((cs) => {
    assert.deepEqual(cs, [0, 0, 0])
    const data = new SessionStore(dir).read('proj')!
    assert.equal(Object.keys(data.sessions).length, 120)
  })
})

test('storageKey: safe ids pass through, unsafe ones hash', () => {
  assert.equal(storageKey('my-project_1.0'), 'my-project_1.0')
  assert.notEqual(storageKey('../escape'), '../escape')
  assert.match(storageKey('../escape'), /^p-[0-9a-f]{16}$/)
  assert.match(storageKey('.hidden'), /^p-/)
  assert.match(storageKey('a/b'), /^p-/)
  assert.match(storageKey('x'.repeat(65)), /^p-/)
  assert.equal(storageKey('a/b'), storageKey('a/b'), 'stable')
})
