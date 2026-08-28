import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globToRegExp, literalPrefix } from '../.opencode/plugin/tensorlake/core/glob-match.js'

const m = (pattern: string, path: string) => globToRegExp(pattern).test(path)

test('* stays inside one path segment', () => {
  assert.equal(m('*.ts', 'a.ts'), true)
  assert.equal(m('*.ts', 'src/a.ts'), false)
})

test('** crosses segments, and **/ matches zero directories', () => {
  assert.equal(m('src/**/*.ts', 'src/a.ts'), true)
  assert.equal(m('src/**/*.ts', 'src/x/y/a.ts'), true)
  assert.equal(m('src/**/*.ts', 'lib/a.ts'), false)
  assert.equal(m('**/*.md', 'README.md'), true)
})

test('? matches one non-slash character', () => {
  assert.equal(m('a?c', 'abc'), true)
  assert.equal(m('a?c', 'a/c'), false)
  assert.equal(m('a?c', 'ac'), false)
})

test('character classes and negation', () => {
  assert.equal(m('[ab].txt', 'a.txt'), true)
  assert.equal(m('[!ab].txt', 'a.txt'), false)
  assert.equal(m('[^ab].txt', 'c.txt'), true)
  assert.equal(m('[]a].txt', ']a.txt'.slice(0, 1) + '.txt'), true)
  // Unterminated class is a literal bracket.
  assert.equal(m('[abc', '[abc'), true)
})

test('brace alternation, nested and unclosed', () => {
  assert.equal(m('*.{ts,js}', 'a.js'), true)
  assert.equal(m('*.{ts,js}', 'a.py'), false)
  assert.equal(m('{src,lib}/**/*.{ts,{js,mjs}}', 'lib/a/b.mjs'), true)
  assert.doesNotThrow(() => globToRegExp('{a,b'))
})

test('regex metacharacters and escapes are literal', () => {
  assert.equal(m('a.b', 'aXb'), false)
  assert.equal(m('a+b', 'a+b'), true)
  assert.equal(m('a\\*b', 'a*b'), true)
  assert.equal(m('a\\*b', 'axb'), false)
})

test('literalPrefix: leading literal directories only', () => {
  assert.equal(literalPrefix('src/**/*.ts'), 'src')
  assert.equal(literalPrefix('src/lib/*.ts'), 'src/lib')
  assert.equal(literalPrefix('*.ts'), '')
  assert.equal(literalPrefix('src/{a,b}/*.ts'), 'src')
  assert.equal(literalPrefix('/abs/*.ts'), '')
  assert.equal(literalPrefix('../x/*.ts'), '')
  assert.equal(literalPrefix('a//b/*.ts'), 'a')
})
