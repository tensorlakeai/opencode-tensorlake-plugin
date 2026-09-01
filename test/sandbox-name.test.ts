import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sandboxName } from '../.opencode/plugin/tensorlake/core/session-manager.js'

test('sandboxName is deterministic and derived from the session id', () => {
  assert.equal(sandboxName('ses_abc123'), 'opencode-ses-abc123')
  assert.equal(sandboxName('ses_abc123'), sandboxName('ses_abc123'))
  assert.notEqual(sandboxName('ses_a'), sandboxName('ses_b'))
})

test('sandboxName only holds lowercase letters, digits, and dashes, at most 63 chars', () => {
  const name = sandboxName('SES_Weird/Chars.Here:' + 'x'.repeat(80))
  assert.match(name, /^[a-z0-9-]+$/)
  assert.ok(name.length <= 63)
  assert.ok(name.startsWith('opencode-'))
})
