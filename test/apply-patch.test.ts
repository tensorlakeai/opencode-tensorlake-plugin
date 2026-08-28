import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePatch, applyHunks } from '../.opencode/plugin/tensorlake/tools/apply-patch.js'

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`

test('parsePatch: Add, Update with Move, Delete', () => {
  const ops = parsePatch(
    wrap(
      [
        '*** Add File: a.txt',
        '+hello',
        '+',
        '+world',
        '*** Update File: b.txt',
        '*** Move to: c.txt',
        '@@ fn main',
        ' keep',
        '-old',
        '+new',
        '*** Delete File: d.txt',
      ].join('\n'),
    ),
  )
  assert.equal(ops.length, 3)
  assert.deepEqual(ops[0], { type: 'add', path: 'a.txt', lines: ['hello', '', 'world'] })
  const up = ops[1]
  assert.equal(up.type, 'update')
  if (up.type === 'update') {
    assert.equal(up.path, 'b.txt')
    assert.equal(up.movePath, 'c.txt')
    assert.equal(up.hunks.length, 1)
    assert.equal(up.hunks[0].anchor, 'fn main')
    assert.deepEqual(
      up.hunks[0].parts.map((p) => p.kind),
      ['ctx', 'del', 'add'],
    )
  }
  assert.deepEqual(ops[2], { type: 'delete', path: 'd.txt' })
})

test('parsePatch: tolerates CRLF and leading blank lines', () => {
  const ops = parsePatch('\r\n\r\n*** Begin Patch\r\n*** Add File: x\r\n+1\r\n*** End Patch\r\n')
  assert.deepEqual(ops, [{ type: 'add', path: 'x', lines: ['1'] }])
})

test('parsePatch: End of File marker flags the hunk', () => {
  const ops = parsePatch(wrap('*** Update File: f\n-last\n+LAST\n*** End of File'))
  assert.equal(ops[0].type, 'update')
  if (ops[0].type === 'update') assert.equal(ops[0].hunks[0].eof, true)
})

test('parsePatch: rejects malformed envelopes', () => {
  assert.throws(() => parsePatch('*** Add File: a\n+1\n*** End Patch'), /must start with/)
  assert.throws(() => parsePatch('*** Begin Patch\n*** Add File: a\n+1'), /must end with/)
  assert.throws(() => parsePatch('*** Begin Patch\n*** End Patch'), /no file operations/)
  assert.throws(() => parsePatch(wrap('*** Add File: a\nno plus')), /every line must start with/)
  assert.throws(() => parsePatch(wrap('*** Update File: a')), /has no hunks/)
  assert.throws(() => parsePatch(wrap('*** Update File: a\n?bad')), /unexpected line/)
  assert.throws(() => parsePatch(wrap('*** Rename File: a')), /unexpected line in patch/)
})

test('applyHunks: replaces a context block, keeps the rest', () => {
  const out = applyHunks(
    'a\nb\nc\nd\n',
    [{ parts: [{ kind: 'ctx', line: 'b' }, { kind: 'del', line: 'c' }, { kind: 'add', line: 'C' }] }],
    'f',
  )
  assert.equal(out, 'a\nb\nC\nd\n')
})

test('applyHunks: anchor narrows the search to the second occurrence', () => {
  const src = 'fn a() {\n  x = 1\n}\nfn b() {\n  x = 1\n}\n'
  const out = applyHunks(
    src,
    [{ anchor: 'fn b() {', parts: [{ kind: 'del', line: '  x = 1' }, { kind: 'add', line: '  x = 2' }] }],
    'f',
  )
  assert.equal(out, 'fn a() {\n  x = 1\n}\nfn b() {\n  x = 2\n}\n')
})

test('applyHunks: whitespace-fuzzy match keeps the file’s own context lines', () => {
  const src = 'keep   \nold\n'
  const out = applyHunks(
    src,
    [{ parts: [{ kind: 'ctx', line: 'keep' }, { kind: 'del', line: 'old' }, { kind: 'add', line: 'new' }] }],
    'f',
  )
  assert.equal(out, 'keep   \nnew\n')
})

test('applyHunks: pure insertion appends before the trailing newline', () => {
  const out = applyHunks('a\nb\n', [{ parts: [{ kind: 'add', line: 'c' }] }], 'f')
  assert.equal(out, 'a\nb\nc\n')
})

test('applyHunks: pure insertion after an anchor', () => {
  const out = applyHunks('a\nb\n', [{ anchor: 'a', parts: [{ kind: 'add', line: 'a2' }] }], 'f')
  assert.equal(out, 'a\na2\nb\n')
})

test('applyHunks: EOF hunk matches the tail, not an earlier copy', () => {
  const src = 'x\ny\nx\n'
  const out = applyHunks(src, [{ eof: true, parts: [{ kind: 'del', line: 'x' }, { kind: 'add', line: 'Z' }] }], 'f')
  assert.equal(out, 'x\ny\nZ\n')
})

test('applyHunks: missing context is an error that names the file', () => {
  assert.throws(
    () => applyHunks('a\n', [{ parts: [{ kind: 'del', line: 'nope' }] }], 'src/f.ts'),
    /context not found in src\/f\.ts near: nope/,
  )
})

test('applyHunks: hunks apply in order, each after the previous', () => {
  const src = 'a\nb\na\nb\n'
  const out = applyHunks(
    src,
    [
      { parts: [{ kind: 'del', line: 'b' }, { kind: 'add', line: 'B1' }] },
      { parts: [{ kind: 'del', line: 'b' }, { kind: 'add', line: 'B2' }] },
    ],
    'f',
  )
  assert.equal(out, 'a\nB1\na\nB2\n')
})
