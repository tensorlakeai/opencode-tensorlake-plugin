import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionTree } from '../.opencode/plugin/tensorlake/core/session-tree.js'

function fakeCtx(parents: Record<string, string | undefined>, calls: string[] = [], fail = new Set<string>()) {
  return {
    client: {
      session: {
        get: async ({ path }: { path: { id: string } }) => {
          calls.push(path.id)
          if (fail.has(path.id)) throw new Error('boom')
          return { data: { id: path.id, parentID: parents[path.id] } }
        },
      },
    },
  } as any
}

test('a subagent resolves to the root session', async () => {
  const tree = new SessionTree()
  const ctx = fakeCtx({ child: 'root', grandchild: 'child' })
  assert.equal(await tree.root('grandchild', ctx), 'root')
  assert.equal(await tree.root('root', ctx), 'root')
})

test('links noted from events avoid lookups', async () => {
  const tree = new SessionTree()
  const calls: string[] = []
  tree.note('child', 'root')
  tree.note('root', null)
  assert.equal(await tree.root('child', fakeCtx({}, calls)), 'root')
  assert.deepEqual(calls, [])
  assert.equal(tree.knows('child'), true)
})

test('rootCached never does I/O; unknown session is its own root', () => {
  const tree = new SessionTree()
  tree.note('child', 'root')
  assert.equal(tree.rootCached('child'), 'root')
  assert.equal(tree.rootCached('stranger'), 'stranger')
})

test('concurrent lookups of one session cost one round trip', async () => {
  const tree = new SessionTree()
  const calls: string[] = []
  const ctx = fakeCtx({ child: 'root' }, calls)
  await Promise.all([tree.root('child', ctx), tree.root('child', ctx), tree.root('child', ctx)])
  assert.deepEqual(calls.filter((c) => c === 'child').length, 1)
})

test('a failed lookup is not cached as a root', async () => {
  const tree = new SessionTree()
  const calls: string[] = []
  const fail = new Set(['child'])
  const ctx = fakeCtx({ child: 'root' }, calls, fail)
  assert.equal(await tree.root('child', ctx), 'child')
  fail.clear()
  assert.equal(await tree.root('child', ctx), 'root')
  assert.equal(tree.knows('child'), true)
})

test('cycles and self-parents do not loop', async () => {
  const tree = new SessionTree()
  tree.note('a', 'b')
  tree.note('b', 'a')
  tree.note('c', 'c')
  assert.equal(tree.rootCached('a'), 'b')
  assert.equal(tree.rootCached('c'), 'c')
  const ctx = fakeCtx({ x: 'y', y: 'x' })
  assert.equal(await tree.root('x', ctx), 'y')
})

test('forget removes the session and its children', () => {
  const tree = new SessionTree()
  tree.note('root', null)
  tree.note('child', 'root')
  tree.forget('root')
  assert.equal(tree.knows('root'), false)
  assert.equal(tree.knows('child'), false)
})

test('no client available: session is its own root', async () => {
  const tree = new SessionTree()
  assert.equal(await tree.root('lonely', undefined), 'lonely')
  assert.equal(await tree.root('lonely', {} as any), 'lonely')
})
