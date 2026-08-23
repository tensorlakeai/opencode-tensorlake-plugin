import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { xdgData } from 'xdg-basedir'
import { logger } from './logger.js'

/** Provider id shown in `opencode auth login` and used as the auth.json key. */
export const PROVIDER_ID = 'tensorlake'

/** Project-scoped API keys carry their own org/project scope — no extra IDs needed. */
export const PROJECT_KEY_PREFIX = 'tl_apiKey_'

export const LOGIN_HINT =
  'Run `opencode auth login`, select Tensorlake, and paste a project API key from https://cloud.tensorlake.ai — or set TENSORLAKE_API_KEY.'

// OpenCode's credential store, written by `opencode auth login`.
const AUTH_FILE = join(xdgData ?? '/tmp', 'opencode', 'auth.json')

// The parsed auth.json is cached keyed on the file's mtime, so a login/logout
// done at any time — another terminal, or the same session — is picked up on
// the next call without restarting OpenCode. mtimeMs is null while the file
// does not exist, so its creation invalidates the cache too.
let storeCache: { key: string | undefined; mtimeMs: number | null } | null = null

function authFileMtime(): number | null {
  try {
    return statSync(AUTH_FILE).mtimeMs
  } catch {
    return null
  }
}

function readStoredApiKey(): string | undefined {
  const mtimeMs = authFileMtime()
  if (storeCache && storeCache.mtimeMs === mtimeMs) return storeCache.key
  let key: string | undefined
  try {
    if (mtimeMs !== null) {
      const store = JSON.parse(readFileSync(AUTH_FILE, 'utf-8')) as Record<string, unknown>
      const entry = store[PROVIDER_ID] as { type?: string; key?: string } | undefined
      if (entry?.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0) {
        key = entry.key
      }
    }
  } catch (err) {
    logger.warn(`Failed to read OpenCode auth store ${AUTH_FILE}: ${err}`)
  }
  storeCache = { key, mtimeMs }
  return key
}

/**
 * Credential resolution order: TENSORLAKE_API_KEY env var (CI/automation
 * override) first, then the key stored by `opencode auth login`.
 */
export function resolveApiKey(): string | undefined {
  const envKey = process.env.TENSORLAKE_API_KEY
  if (envKey && envKey.length > 0) return envKey
  return readStoredApiKey()
}

/**
 * OpenCode's built-in API-key prompt cannot validate the key at login (the
 * plugin never sees the masked value), so keys are checked here on first use.
 * A non-project key still works when its scope is supplied via env vars, so
 * this is a warning, not a hard failure.
 */
export function projectKeyWarning(apiKey: string): string | undefined {
  if (apiKey.startsWith(PROJECT_KEY_PREFIX)) return undefined
  if (process.env.TENSORLAKE_ORGANIZATION_ID && process.env.TENSORLAKE_PROJECT_ID) return undefined
  return (
    `The stored key is not a project API key (${PROJECT_KEY_PREFIX}...). ` +
    'Sandbox calls may fail. Re-run `opencode auth login` with a project API key from ' +
    'https://cloud.tensorlake.ai (Project → API Keys), or set TENSORLAKE_ORGANIZATION_ID and TENSORLAKE_PROJECT_ID.'
  )
}
