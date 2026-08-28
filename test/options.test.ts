import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFileSystemMount } from '../.opencode/plugin/tensorlake/core/filesystem.js'
import { resolveGitRepo } from '../.opencode/plugin/tensorlake/core/git-bootstrap.js'
import { shellQuote } from '../.opencode/plugin/tensorlake/core/shell.js'
import { execFileSync } from 'node:child_process'

const ENV = ['TENSORLAKE_FILESYSTEM', 'TENSORLAKE_FILESYSTEM_PATH', 'TENSORLAKE_GIT_REPO']
afterEach(() => ENV.forEach((k) => delete process.env[k]))

test('filesystem: nothing configured -> no mount', () => {
  assert.equal(resolveFileSystemMount(undefined, '/tmp/workspace'), undefined)
  assert.equal(resolveFileSystemMount({ filesystem: '   ' }, '/tmp/workspace'), undefined)
  assert.equal(resolveFileSystemMount({ filesystem: 42 }, '/tmp/workspace'), undefined)
})

test('filesystem: plugin option mounts at the work dir by default', () => {
  assert.deepEqual(resolveFileSystemMount({ filesystem: ' demo-fs ' }, '/tmp/workspace'), {
    fileSystemId: 'demo-fs',
    mountPath: '/tmp/workspace',
  })
})

test('filesystem: env var wins over the option; path option honoured', () => {
  process.env.TENSORLAKE_FILESYSTEM = 'env-fs'
  assert.equal(resolveFileSystemMount({ filesystem: 'opt-fs' }, '/w')?.fileSystemId, 'env-fs')
  assert.equal(resolveFileSystemMount({ filesystem: 'x', filesystemPath: '/data' }, '/w')?.mountPath, '/data')
  process.env.TENSORLAKE_FILESYSTEM_PATH = '/env-path'
  assert.equal(resolveFileSystemMount({ filesystem: 'x', filesystemPath: '/data' }, '/w')?.mountPath, '/env-path')
})

test('gitRepo: option, env precedence, blank -> undefined', () => {
  assert.equal(resolveGitRepo(undefined), undefined)
  assert.equal(resolveGitRepo({ gitRepo: '  ' }), undefined)
  assert.equal(resolveGitRepo({ gitRepo: ' repo ' }), 'repo')
  process.env.TENSORLAKE_GIT_REPO = 'env-repo'
  assert.equal(resolveGitRepo({ gitRepo: 'opt-repo' }), 'env-repo')
})

test('shellQuote survives the shell', () => {
  for (const s of ["it's", 'a b', '$HOME `id` "x"', '', "'; rm -rf / #"]) {
    const out = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(s)}`], { encoding: 'utf-8' })
    assert.equal(out, s)
  }
})
