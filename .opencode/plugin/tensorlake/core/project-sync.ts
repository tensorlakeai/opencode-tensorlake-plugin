import { createHash } from 'crypto'
import { existsSync, readdirSync, lstatSync, statSync, unlinkSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, basename, dirname } from 'path'
import { posix } from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { RepositoryClient, FilesystemClient, CloudClient } from 'tensorlake'
import type { FileSystemMount, FileEntry } from 'tensorlake'
import { logger } from './logger.js'
import type { TensorlakeClient } from './client.js'

export type SyncMode = 'git' | 'volume' | 'mount' | 'off'

// Directories that are always regenerable and expensive to upload.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'target',
  '.DS_Store',
])

// Files larger than this are skipped in volume mode.
const MAX_FILE_BYTES = 100 * 1024 * 1024

// Uncommitted-changes patches larger than this are not synced into the sandbox.
const MAX_PATCH_BYTES = 50 * 1024 * 1024

// Older versions wrote the sync manifest into the volume root, i.e. into the
// tree mounted as the agent's project dir. That let sandbox code rewrite the
// file that drives laptop-side deletions, so the manifest now lives on the
// laptop (see syncManifestPath) and this legacy on-volume copy is scrubbed.
const LEGACY_VOLUME_MANIFEST_PATH = '.tensorlake-sync-manifest.json'

const execFileAsync = promisify(execFile)

function apiUrl(): string | undefined {
  return process.env.TENSORLAKE_API_URL
}

type Scope = { organizationId: string; projectId: string }

// Cached per key: the stored key can change without a restart (auth login in
// another terminal), and a new key may belong to a different project.
let cachedScope: { apiKey: string; scope: Scope } | null = null

function pickId(value: unknown, keys: string[]): string | undefined {
  if (value == null || typeof value !== 'object') return undefined
  const obj = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = obj[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Resolve the organization/project scope required by the git and filesystem
 * APIs. A key that carries its own scope is introspected and that scope wins:
 * a stale TENSORLAKE_PROJECT_ID left in the shell would otherwise make every
 * call fail with an opaque 401. Env vars are the answer only for keys that
 * carry no scope (PATs), or when introspection cannot be reached.
 */
async function resolveScope(apiKey: string): Promise<Scope> {
  const envOrg = process.env.TENSORLAKE_ORGANIZATION_ID
  const envProj = process.env.TENSORLAKE_PROJECT_ID
  const envScope = envOrg && envProj ? { organizationId: envOrg, projectId: envProj } : undefined
  if (cachedScope && cachedScope.apiKey === apiKey) return cachedScope.scope

  const client = CloudClient.forCloud({ apiKey, ...(apiUrl() ? { apiUrl: apiUrl() } : {}) })
  try {
    let intro: Record<string, unknown>
    try {
      intro = (await client.introspectApiKey()) as Record<string, unknown>
    } catch (err) {
      // Unreachable or unintrospectable key: env vars are all that is left.
      if (envScope) {
        logger.warn(`Could not introspect the API key (${err}); using TENSORLAKE_ORGANIZATION_ID/TENSORLAKE_PROJECT_ID.`)
        cachedScope = { apiKey, scope: envScope }
        return envScope
      }
      throw err
    }
    const keyOrg =
      pickId(intro, ['organizationId', 'organization_id']) ??
      pickId(intro.organization, ['id', 'organizationId', 'organization_id'])
    const keyProj =
      pickId(intro, ['projectId', 'project_id']) ??
      pickId(intro.project, ['id', 'projectId', 'project_id'])
    const organizationId = keyOrg ?? envOrg
    const projectId = keyProj ?? envProj
    if (!organizationId || !projectId) {
      throw new Error(
        'Could not resolve organization/project from the API key. Set TENSORLAKE_ORGANIZATION_ID and TENSORLAKE_PROJECT_ID.',
      )
    }
    if (envScope && (envScope.organizationId !== organizationId || envScope.projectId !== projectId)) {
      logger.warn(
        `TENSORLAKE_ORGANIZATION_ID/TENSORLAKE_PROJECT_ID (${envScope.organizationId}/${envScope.projectId}) do not match the API key's own scope (${organizationId}/${projectId}); using the key's scope. Unset those variables to silence this.`,
      )
    }
    cachedScope = { apiKey, scope: { organizationId, projectId } }
    return cachedScope.scope
  } finally {
    client.close()
  }
}

async function cloudOptions(apiKey: string) {
  const scope = await resolveScope(apiKey)
  return {
    apiKey,
    ...(apiUrl() ? { apiUrl: apiUrl() } : {}),
    ...scope,
  }
}

export function sanitizeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
}

/** Directory name the project is synced to inside the sandbox workspace. */
export function projectDirName(worktree: string): string {
  const name = basename(worktree ?? '').replace(/[^a-zA-Z0-9._-]/g, '-')
  return name || 'project'
}

/**
 * Detected mode per worktree, plus the filesystem a 'mount' worktree serves.
 * Filled once by {@link detectSyncMode} at plugin startup so that the
 * synchronous {@link resolveSyncMode} — called on every tool call — never has
 * to run the mount probe again.
 */
const detectedModes = new Map<string, { mode: SyncMode; fileSystemId?: string }>()

function envSyncMode(): SyncMode | 'auto' {
  const env = (process.env.TENSORLAKE_SYNC_MODE ?? 'auto').toLowerCase()
  if (env === 'git' || env === 'volume' || env === 'mount' || env === 'off') return env
  return 'auto'
}

/**
 * Mode derived from the worktree alone — everything except 'mount', which
 * needs the mount daemon and so is resolved by {@link detectSyncMode}.
 */
function deriveSyncMode(worktree: string): SyncMode {
  const env = envSyncMode()
  if (env === 'git' || env === 'volume' || env === 'off') return env
  if (!worktree || worktree === '/' || !existsSync(worktree)) return 'off'
  return existsSync(join(worktree, '.git')) ? 'git' : 'volume'
}

/**
 * Resolve how the local project is synced into the sandbox.
 * TENSORLAKE_SYNC_MODE=git|volume|mount|off overrides; default 'auto' picks
 * 'mount' when the project folder is already a Tensorlake filesystem mount,
 * 'git' for git repositories, and an uploaded cloud volume otherwise.
 *
 * Synchronous, so it answers from what detectSyncMode found; without that it
 * can still answer everything but 'mount'.
 */
export function resolveSyncMode(worktree: string): SyncMode {
  return detectedModes.get(worktree)?.mode ?? deriveSyncMode(worktree)
}

/**
 * Resolve the mode once, including the probe for a local Tensorlake mount, and
 * cache it for the process. Call this before any other sync entry point.
 */
export async function detectSyncMode(worktree: string): Promise<SyncMode> {
  const cached = detectedModes.get(worktree)
  if (cached) return cached.mode

  const env = envSyncMode()
  const derived = deriveSyncMode(worktree)
  // Nothing to probe: the mode is pinned, or there is no project to sync.
  if ((env !== 'auto' && env !== 'mount') || derived === 'off') {
    detectedModes.set(worktree, { mode: derived })
    return derived
  }
  // The probe shells out to the `tl` CLI, so it only runs where a mount can
  // actually be: a directory that is its own mount point.
  if (env === 'mount' || isMountPoint(worktree)) {
    const fileSystemId = await mountedFileSystem(worktree)
    if (fileSystemId) {
      logger.info(
        `${worktree} is a Tensorlake filesystem mount (${fileSystemId}); the sandbox will mount the same filesystem`,
      )
      detectedModes.set(worktree, { mode: 'mount', fileSystemId })
      return 'mount'
    }
    if (env === 'mount') {
      logger.warn(
        `TENSORLAKE_SYNC_MODE=mount, but ${worktree} is not a Tensorlake filesystem mount; falling back to ${derived}. Mount one with \`tl fs mount <name> <empty dir>\`.`,
      )
    }
  }
  detectedModes.set(worktree, { mode: derived })
  return derived
}

/** The filesystem a 'mount' worktree serves, once detectSyncMode has run. */
export function mountedFileSystemId(worktree: string): string | undefined {
  return detectedModes.get(worktree)?.fileSystemId
}

/**
 * True when `path` is the root of its own filesystem. A mount point's device
 * id differs from its parent's — the cheap, dependency-free way to skip the
 * CLI probe for the overwhelming majority of folders, which are plain
 * directories on the boot volume.
 */
function isMountPoint(path: string): boolean {
  try {
    const parent = dirname(path)
    if (parent === path) return true
    return statSync(path).dev !== statSync(parent).dev
  } catch {
    return false
  }
}

/**
 * Name of the Tensorlake filesystem mounted at `path`, or undefined when the
 * path is not a Tensorlake mount (a plain folder, or some other mounted
 * volume). The SDK's FilesystemClient.mountStatus() answers the same question,
 * but constructing that client requires cloud credentials and project scope —
 * and this probe runs at plugin startup, before any of that is guaranteed, for
 * a purely local check. So the CLI is asked directly, parsing the same fields
 * the SDK does.
 */
async function mountedFileSystem(path: string): Promise<string | undefined> {
  const cli = await findFsCli()
  if (!cli) {
    logger.info('`tl` CLI not found; cannot check whether the project folder is a Tensorlake filesystem mount')
    return undefined
  }
  let raw: Record<string, unknown>
  try {
    const { stdout } = await execFileAsync(cli, ['fs', 'status', '--json', '--', path], { timeout: 60_000 })
    raw = JSON.parse(stdout) as Record<string, unknown>
  } catch (err: any) {
    // The expected outcome for a plain folder: the CLI exits non-zero with
    // "not inside a Tensorlake filesystem mount".
    const detail = `${err?.stderr ?? err?.message ?? err}`.trim().slice(0, 200)
    logger.info(`No Tensorlake mount at ${path}: ${detail}`)
    return undefined
  }
  // Field names follow the SDK's own reading of this payload, which is
  // versioned independently of the SDK.
  const mounted = 'mounted' in raw ? Boolean(raw.mounted) : 'active' in raw ? Boolean(raw.active) : true
  const name = raw.filesystem ?? raw.file_system ?? raw.repository
  if (!mounted || typeof name !== 'string' || !name) return undefined
  return name
}

/** The `tl` binary: TENSORLAKE_CLI override, PATH, or the default install location — the SDK's own search order. */
async function findFsCli(): Promise<string | undefined> {
  const candidates = process.env.TENSORLAKE_CLI
    ? [process.env.TENSORLAKE_CLI, 'tl', join(homedir(), '.tensorlake', 'bin', 'tl')]
    : ['tl', join(homedir(), '.tensorlake', 'bin', 'tl')]
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['fs', '--help'], { timeout: 15_000 })
      return candidate
    } catch (err: any) {
      // Present but unhappy (wrong version, no auth) still means `tl` is there.
      if (err?.code !== 'ENOENT') return candidate
    }
  }
  return undefined
}

/** Name shared by the hosted git repo (git mode) and cloud volume (volume mode). */
function syncResourceName(projectId: string): string {
  return sanitizeName(`opencode-${projectId}`)
}

// Branch names that are safe to embed in the single-quoted sandbox sync
// script and in refspecs. Git allows more than this (e.g. quotes), but such
// names cannot be forwarded verbatim, so they sync as 'main' instead.
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/

/**
 * The branch the project syncs under: the local checkout's current branch,
 * kept under the same name on the sync repo and in the sandbox clone, so agent
 * pushes land exactly where the user expects. Falls back to 'main' for a
 * detached HEAD or a name that cannot be embedded safely.
 */
export async function resolveSyncBranch(worktree: string): Promise<string> {
  let name: string
  try {
    // --show-current also answers on an unborn branch (fresh `git init`),
    // where rev-parse HEAD has nothing to resolve.
    name = (await localGit(worktree, ['branch', '--show-current'])).trim()
  } catch {
    return 'main'
  }
  if (!name) {
    logger.warn('Local checkout is a detached HEAD; syncing as branch main')
    return 'main'
  }
  if (name.startsWith('-') || !SAFE_BRANCH_RE.test(name)) {
    logger.warn(`Local branch name ${JSON.stringify(name)} cannot be synced verbatim; syncing as branch main`)
    return 'main'
  }
  return name
}

/** Run git in the local worktree; rejects with stderr attached on failure. */
async function localGit(worktree: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: worktree,
    maxBuffer: MAX_PATCH_BYTES + 1024 * 1024,
    timeout: 300_000,
    // LC_ALL=C keeps git's messages untranslated: pushRealHistory classifies
    // push failures by matching git's English error strings.
    env: { ...process.env, LC_ALL: 'C', ...env },
  })
  return stdout
}

// Credentials go in an HTTP header instead of the remote URL so the token
// never appears in git's error output or the process list.
function gitAuthConfig(cred: { gitUsername: string; token: string }): string {
  const basic = Buffer.from(`${cred.gitUsername}:${cred.token}`).toString('base64')
  return `http.extraHeader=Authorization: Basic ${basic}`
}

function redactAuth(text: string): string {
  return text.replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***')
}

// Throwaway ref the sync repo's sync branch is fetched into for the ancestry
// check, so the user's FETCH_HEAD (which their own fetch/merge workflows may
// be reading) is never touched.
const SYNC_REPO_CHECK_REF = 'refs/tensorlake/sync-repo-check'

/** True when `ancestor` is reachable from `descendant`. */
async function isAncestor(worktree: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await localGit(worktree, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (err: any) {
    // Exit code 1 is merge-base's defined "not an ancestor" answer. Anything
    // else (128, a timeout) means the check itself failed, and must propagate
    // so callers treat the state as indeterminate instead of acting on it.
    if (err?.code === 1) return false
    throw err
  }
}

/**
 * True when the sync repo's sync branch already contains local HEAD — i.e. the
 * sync repo is simply ahead (an agent pushed commits the laptop hasn't fetched
 * yet), as opposed to local history having been rewritten. Fetches the
 * sync repo's branch into a temporary ref to make the ancestry check possible.
 */
async function syncRepoContainsLocalHead(
  repos: RepositoryClient,
  repo: string,
  worktree: string,
  branch: string,
): Promise<boolean> {
  const cred = await repos.credential(repo)
  await localGit(worktree, [
    '-c',
    gitAuthConfig(cred),
    'fetch',
    '--quiet',
    '--no-write-fetch-head',
    repos.url(repo),
    `+refs/heads/${branch}:${SYNC_REPO_CHECK_REF}`,
  ])
  try {
    return await isAncestor(worktree, 'HEAD', SYNC_REPO_CHECK_REF)
  } finally {
    await localGit(worktree, ['update-ref', '-d', SYNC_REPO_CHECK_REF]).catch(() => {})
  }
}

/**
 * Push the local repository's real history (HEAD) to the sync repo's sync
 * branch, preserving commits, authors, and dates. A non-fast-forward rejection
 * has two causes that must be told apart: the sync repo being ahead of the laptop
 * (agents commit and push their work to it), in which case the push is simply
 * skipped, or local history having been rewritten by a rebase or amend, in
 * which case the sync repo is deleted, recreated, and pushed fresh.
 */
async function pushRealHistory(repos: RepositoryClient, repo: string, worktree: string, branch: string): Promise<void> {
  const push = async () => {
    const cred = await repos.credential(repo)
    await localGit(worktree, ['-c', gitAuthConfig(cred), 'push', '--quiet', repos.url(repo), `HEAD:refs/heads/${branch}`])
  }
  try {
    await push()
  } catch (err: any) {
    const detail = redactAuth(`${err?.stderr ?? ''} ${err?.message ?? err}`)
    if (!/non-fast-forward|\[rejected\]|failed to push some refs|fetch first/i.test(detail)) {
      throw new Error(`git push to sync repo ${repo} failed: ${detail}`)
    }
    let remoteAhead: boolean
    try {
      remoteAhead = await syncRepoContainsLocalHead(repos, repo, worktree, branch)
    } catch (checkErr: any) {
      // Indeterminate state: never recreate the sync repo without proof of a
      // rewrite, or agent commits that exist only on the sync repo would be lost.
      throw new Error(
        `Sync repo ${repo} rejected a non-fast-forward push and its state could not be inspected; not recreating it to avoid discarding remote-only commits: ${redactAuth(`${checkErr?.stderr ?? ''} ${checkErr?.message ?? checkErr}`)}`,
      )
    }
    if (remoteAhead) {
      logger.info(
        `Sync repo ${repo} is ahead of local HEAD (agent commits not yet fetched locally); skipping push — local history is already on the sync repo.`,
      )
      return
    }
    logger.warn(
      `Sync repo ${repo} rejected a non-fast-forward push and its ${branch} branch does not contain local HEAD (local history was rewritten); recreating the sync repo. Commits that existed only on the sync repo are discarded.`,
    )
    await repos.delete(repo)
    await repos.create(repo, { defaultBranch: branch })
    try {
      await push()
    } catch (err2: any) {
      throw new Error(
        `git push after recreating sync repo ${repo} failed: ${redactAuth(`${err2?.stderr ?? ''} ${err2?.message ?? err2}`)}`,
      )
    }
  }
}

/**
 * Diff of everything not yet committed locally (modified, staged, untracked,
 * deleted), built against a temporary index so the real index is untouched.
 * Returns null when the working tree is clean or the patch is oversized.
 */
async function buildUncommittedPatch(worktree: string): Promise<string | null> {
  const tmpIndex = join(tmpdir(), `tensorlake-sync-index-${process.pid}-${Date.now()}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    await localGit(worktree, ['read-tree', 'HEAD'], env)
    await localGit(worktree, ['add', '-A'], env)
    const patch = await localGit(worktree, ['diff', '--cached', '--binary', 'HEAD'], env)
    if (!patch.trim()) return null
    const bytes = Buffer.byteLength(patch)
    if (bytes > MAX_PATCH_BYTES) {
      logger.warn(`Uncommitted changes are ${bytes} bytes (> ${MAX_PATCH_BYTES}); not syncing them into the sandbox`)
      return null
    }
    return patch
  } finally {
    try {
      unlinkSync(tmpIndex)
    } catch {
      // temp index may not exist if an early git call failed
    }
  }
}

/**
 * Compact fingerprint of the local repo state that inbound sync replicates:
 * branch, HEAD, and a hash of the uncommitted patch. Two equal fingerprints
 * mean an inbound re-sync would be a no-op. Null when the state cannot be
 * read (callers then skip re-sync rather than churn).
 */
export async function localGitFingerprint(worktree: string): Promise<string | null> {
  try {
    const branch = await resolveSyncBranch(worktree)
    let head = ''
    try {
      head = (await localGit(worktree, ['rev-parse', 'HEAD'])).trim()
    } catch {
      // no commits yet — the snapshot path syncs the worktree instead
    }
    // An oversized patch returns null and so hashes like a clean tree: such
    // changes are not synced either way, and must not trigger re-sync churn.
    const patch = head ? await buildUncommittedPatch(worktree) : null
    const patchHash = patch ? createHash('sha1').update(patch).digest('hex') : ''
    return `${branch}\n${head}\n${patchHash}`
  } catch (err) {
    logger.warn(`Could not fingerprint local repo state: ${err}`)
    return null
  }
}

/**
 * Replicate uncommitted local changes into the sandbox working tree without
 * committing them, so the sandbox matches the laptop's exact state. Applied
 * only when the sandbox tree is clean and at the same HEAD as the laptop —
 * agent work in the sandbox is never overwritten.
 */
async function applyUncommittedChanges(
  client: TensorlakeClient,
  sandboxId: string,
  worktree: string,
  destDir: string,
  localHead: string,
): Promise<void> {
  const patch = await buildUncommittedPatch(worktree)
  if (!patch) return
  const state = await client.executeCommand(sandboxId, `cd '${destDir}' && git rev-parse HEAD && git status --porcelain`, '/')
  if (state.exitCode !== 0) {
    logger.warn(`Could not inspect sandbox clone before applying uncommitted changes: ${state.stderr || state.stdout}`)
    return
  }
  const [sandboxHead, ...statusLines] = state.stdout.trim().split('\n')
  const dirty = statusLines.some((line) => line.trim() !== '')
  if (sandboxHead !== localHead || dirty) {
    logger.info(
      `Skipping uncommitted-changes sync: sandbox tree ${dirty ? 'has its own modifications' : `is at ${sandboxHead?.slice(0, 8)}, not ${localHead.slice(0, 8)}`}`,
    )
    return
  }
  const patchPath = '/tmp/.tensorlake-sync.patch'
  await client.writeFile(sandboxId, patchPath, Buffer.from(patch))
  const apply = await client.executeCommand(
    sandboxId,
    `cd '${destDir}' && git apply --whitespace=nowarn '${patchPath}'; code=$?; rm -f '${patchPath}'; exit $code`,
    '/',
  )
  if (apply.exitCode !== 0) {
    logger.warn(`Failed to apply uncommitted local changes in sandbox: ${apply.stderr || apply.stdout}`)
  } else {
    logger.info(`Applied uncommitted local changes (${Buffer.byteLength(patch)} bytes) to ${destDir}`)
  }
}

/**
 * Sync the local git repository into the sandbox with full commit history:
 * push real refs to a Tensorlake-sync repo, then clone (or fast-forward)
 * the sync repo inside the sandbox at `destDir`, and finally replay uncommitted
 * local changes onto the sandbox working tree. A repo with no commits yet
 * falls back to a single snapshot commit via pushWorktree.
 *
 * Returns 'synced' when the sandbox clone now matches the pushed state, and
 * 'diverged' when the clone has its own commits or changes and was left alone
 * (the pushed state is still on its 'origin' remote).
 */
export async function syncGitProject(
  client: TensorlakeClient,
  apiKey: string,
  sandboxId: string,
  worktree: string,
  projectId: string,
  destDir: string,
): Promise<'synced' | 'diverged'> {
  const repos = RepositoryClient.forCloud(await cloudOptions(apiKey))
  try {
    const repo = syncResourceName(projectId)
    const branch = await resolveSyncBranch(worktree)
    try {
      await repos.info(repo)
    } catch {
      logger.info(`Creating hosted git repository ${repo}`)
      await repos.create(repo, { defaultBranch: branch })
    }

    let localHead: string | null = null
    try {
      localHead = (await localGit(worktree, ['rev-parse', 'HEAD'])).trim()
    } catch {
      // no commits yet, or no usable local git — use the snapshot path
    }

    if (localHead) {
      logger.info(
        `Pushing real history (HEAD ${localHead.slice(0, 8)}, branch ${branch}) from ${worktree} to sync repo ${repo}`,
      )
      await pushRealHistory(repos, repo, worktree, branch)
    } else {
      logger.info(`Local repository has no commits; pushing worktree snapshot to ${repo} (branch ${branch})`)
      await repos.pushWorktree(repo, {
        path: worktree,
        branch,
        message: 'Sync from OpenCode',
      })
    }

    const url = repos.url(repo)
    const credLine = await credentialLine(repos, repo)

    // Re-syncs only fast-forward: a sandbox clone with its own commits or
    // uncommitted changes must never be clobbered by a hard reset. A clean
    // clone left on another branch (the user switched branches locally)
    // switches to the sync branch; a dirty one is left alone. The git
    // identity lets agents commit their work inside the sandbox.
    const script = [
      'set -e',
      'git config --global credential.helper store',
      `printf '%s\\n' '${credLine}' > ~/.git-credentials`,
      `git config --global user.name >/dev/null 2>&1 || git config --global user.name 'OpenCode Agent'`,
      `git config --global user.email >/dev/null 2>&1 || git config --global user.email 'opencode-agent@tensorlake.ai'`,
      `if [ -d '${destDir}/.git' ]; then`,
      `  cd '${destDir}' && git fetch origin '${branch}'`,
      `  current="$(git branch --show-current)"`,
      `  if [ "$current" != '${branch}' ]; then`,
      '    if [ -n "$(git status --porcelain)" ]; then',
      '      echo TENSORLAKE_SYNC_DIVERGED',
      '    else',
      `      git checkout -q '${branch}' 2>/dev/null || git checkout -q -b '${branch}' 'origin/${branch}'`,
      `      git merge --ff-only 'origin/${branch}' || echo TENSORLAKE_SYNC_DIVERGED`,
      '    fi',
      `  elif ! git merge --ff-only 'origin/${branch}'; then`,
      '    echo TENSORLAKE_SYNC_DIVERGED',
      '  fi',
      'else',
      `  rm -rf '${destDir}' && git clone --branch '${branch}' '${url}' '${destDir}'`,
      'fi',
    ].join('\n')

    const result = await client.executeCommand(sandboxId, script, '/', 300_000)
    if (result.exitCode !== 0) {
      throw new Error(`git sync failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
    }
    if (result.stdout.includes('TENSORLAKE_SYNC_DIVERGED')) {
      logger.warn(
        `Sandbox clone at ${destDir} has commits or changes that diverge from the pushed project; left untouched instead of resetting. Delete the session's sandbox to start from a fresh clone.`,
      )
      return 'diverged'
    }
    logger.info(`Project cloned into sandbox at ${destDir}`)
    if (localHead) {
      await applyUncommittedChanges(client, sandboxId, worktree, destDir, localHead)
    }
    return 'synced'
  } finally {
    repos.close()
  }
}

// Git credential store line for the sync repo, in git's expected
// https://user:token@host format.
async function credentialLine(repos: RepositoryClient, repo: string): Promise<string> {
  const cred = await repos.credential(repo)
  const parsed = new URL(repos.url(repo))
  return `${parsed.protocol}//${encodeURIComponent(cred.gitUsername)}:${encodeURIComponent(cred.token)}@${parsed.host}`
}

// Git tokens live about one hour; re-mint the sandbox's stored credential
// well before that so agent pushes keep working in long sessions.
export const GIT_CREDENTIAL_REFRESH_MS = 30 * 60 * 1000

/**
 * Write a freshly minted git credential into the sandbox's credential store,
 * replacing the (possibly expired) one written by the last sync.
 */
export async function refreshSandboxGitCredential(
  client: TensorlakeClient,
  apiKey: string,
  sandboxId: string,
  projectId: string,
): Promise<void> {
  const repos = RepositoryClient.forCloud(await cloudOptions(apiKey))
  try {
    const credLine = await credentialLine(repos, syncResourceName(projectId))
    const result = await client.executeCommand(
      sandboxId,
      `printf '%s\\n' '${credLine}' > ~/.git-credentials`,
      '/',
      30_000,
    )
    if (result.exitCode !== 0) {
      throw new Error(`writing ~/.git-credentials failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
    }
  } finally {
    repos.close()
  }
}

/** What a sync-back pass did, for user-facing reporting. */
export type SyncBackResult =
  | { kind: 'up-to-date' }
  | { kind: 'fast-forwarded'; branch: string; commits: number; oid: string }
  | { kind: 'staged'; branch: string; ref: string; commits: number; oid: string; reason: string }

/** One uncommitted-sandbox-changes capture staged on a local scratch ref. */
export type WipStaged = { branch: string; ref: string; oid: string; files: number }

/** Everything one sync-back pass brought home: committed work plus WIP captures. */
export type SyncBackReport = { committed: SyncBackResult; wip: WipStaged[] }

// Scratch namespace (on the sync repo and locally) holding synthetic commits
// that capture a sandbox clone's uncommitted working tree. Kept outside
// refs/heads and refs/remotes so no branch or fetch workflow ever sees them
// as real history.
const WIP_REF_PREFIX = 'refs/tensorlake-wip/'

/**
 * Pull agent work from the sync repo back into the local repository.
 * Fetches every sync repo branch into refs/remotes/tensorlake/* (so nothing an
 * agent pushed is ever stranded on the sync repo), then fast-forwards the local
 * sync branch when that is safe. Unsafe cases — a dirty worktree or diverged
 * histories — leave the commits on the tensorlake/<branch> tracking ref for
 * the user to merge deliberately; the local checkout is never disturbed.
 * Uncommitted sandbox changes captured by {@link captureSandboxWip} arrive in
 * the same fetch and are only ever staged on local tensorlake-wip/* scratch
 * refs — they are never applied to the user's working tree.
 */
export async function syncBackFromSyncRepo(
  apiKey: string,
  worktree: string,
  projectId: string,
): Promise<SyncBackReport> {
  const branch = await resolveSyncBranch(worktree)
  const repo = syncResourceName(projectId)
  const repos = RepositoryClient.forCloud(await cloudOptions(apiKey))
  try {
    const cred = await repos.credential(repo)
    // --prune drops tracking refs for branches deleted (or recreated) on the
    // sync repo, so a stale tensorlake/* ref can't masquerade as agent work;
    // it likewise drops a local wip ref once the sandbox clears its capture.
    await localGit(worktree, [
      '-c',
      gitAuthConfig(cred),
      'fetch',
      '--quiet',
      '--no-write-fetch-head',
      '--prune',
      repos.url(repo),
      '+refs/heads/*:refs/remotes/tensorlake/*',
      `+${WIP_REF_PREFIX}*:${WIP_REF_PREFIX}*`,
    ])
  } finally {
    repos.close()
  }

  const committed = await reconcileCommitted(worktree, branch)
  const wip = await stagedWipRefs(worktree)
  return { committed, wip }
}

/** Fast-forward or stage the sync repo's committed work, post-fetch. */
async function reconcileCommitted(worktree: string, branch: string): Promise<SyncBackResult> {
  const trackingRef = `refs/remotes/tensorlake/${branch}`
  const shortRef = `tensorlake/${branch}`
  let syncRepoOid: string
  try {
    syncRepoOid = (await localGit(worktree, ['rev-parse', '--verify', '--quiet', trackingRef])).trim()
  } catch {
    return { kind: 'up-to-date' } // branch not on the sync repo yet
  }

  let localOid: string
  try {
    localOid = (await localGit(worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).trim()
  } catch {
    // No local branch to advance (e.g. a repo that had no commits at sync
    // time). The fetch above already saved the agent's work locally.
    return { kind: 'staged', branch, ref: shortRef, commits: 0, oid: syncRepoOid, reason: `local branch ${branch} not found` }
  }

  if (syncRepoOid === localOid) return { kind: 'up-to-date' }
  // Sync repo behind the laptop: the next inbound sync's push handles that.
  if (await isAncestor(worktree, syncRepoOid, localOid)) return { kind: 'up-to-date' }

  const commits =
    parseInt((await localGit(worktree, ['rev-list', '--count', `${localOid}..${syncRepoOid}`])).trim(), 10) || 0
  if (!(await isAncestor(worktree, localOid, syncRepoOid))) {
    return { kind: 'staged', branch, ref: shortRef, commits, oid: syncRepoOid, reason: 'local and agent histories diverged' }
  }

  const current = (await localGit(worktree, ['branch', '--show-current'])).trim()
  if (current !== branch) {
    // The branch exists but is not checked out (detached HEAD fallback):
    // advance the ref directly — no worktree files are involved. The
    // old-value argument makes it a compare-and-swap against races.
    await localGit(worktree, ['update-ref', `refs/heads/${branch}`, syncRepoOid, localOid])
    return { kind: 'fast-forwarded', branch, commits, oid: syncRepoOid }
  }

  const dirty = (await localGit(worktree, ['status', '--porcelain'])).trim() !== ''
  if (dirty) {
    return { kind: 'staged', branch, ref: shortRef, commits, oid: syncRepoOid, reason: 'local uncommitted changes' }
  }

  await localGit(worktree, ['merge', '--ff-only', '--quiet', syncRepoOid])
  return { kind: 'fast-forwarded', branch, commits, oid: syncRepoOid }
}

/** The wip captures currently staged on local tensorlake-wip/* refs. */
async function stagedWipRefs(worktree: string): Promise<WipStaged[]> {
  const out = await localGit(worktree, ['for-each-ref', '--format=%(refname)%00%(objectname)', WIP_REF_PREFIX.slice(0, -1)])
  const staged: WipStaged[] = []
  for (const line of out.split('\n')) {
    const [refname, oid] = line.split('\0')
    if (!refname || !oid) continue
    const branch = refname.slice(WIP_REF_PREFIX.length)
    let files = 0
    try {
      const names = await localGit(worktree, ['diff', '--name-only', `${oid}^`, oid])
      files = names.split('\n').filter((name) => name.trim() !== '').length
    } catch {
      // parentless capture (repo synced as a snapshot) — file count unknown
    }
    // Short form resolves via git's refs/<name> lookup: 'tensorlake-wip/x'
    // -> refs/tensorlake-wip/x, so the ref works in user-facing commands.
    staged.push({ branch, ref: `tensorlake-wip/${branch}`, oid, files })
  }
  return staged
}

export type WipCaptureResult = 'pushed' | 'unchanged' | 'clean' | 'cleared' | 'skipped'

/**
 * Capture the sandbox clone's uncommitted changes (modified + untracked) as a
 * synthetic commit and push it to the sync repo's tensorlake-wip/<branch>
 * scratch ref, where the next sync-back fetch stages it locally. Built against
 * a temporary index, so the sandbox's real index and working tree are never
 * touched — exactly the laptop-side buildUncommittedPatch technique. A clean
 * tree clears a previously pushed capture; an unchanged tree pushes nothing.
 */
export async function captureSandboxWip(
  client: TensorlakeClient,
  sandboxId: string,
  destDir: string,
): Promise<WipCaptureResult> {
  const script = [
    `cd '${destDir}'`,
    'git rev-parse -q --verify HEAD >/dev/null 2>&1 || { echo TENSORLAKE_WIP_SKIPPED; exit 0; }',
    'branch="$(git branch --show-current)"',
    '[ -n "$branch" ] || { echo TENSORLAKE_WIP_SKIPPED; exit 0; }',
    'if [ -z "$(git status --porcelain)" ]; then',
    '  if [ -f .git/tensorlake-wip-tree ]; then',
    // The remote ref may already be gone (repo recreated); the marker is
    // removed either way so a delete failure cannot retry forever.
    '    git push --quiet origin ":refs/tensorlake-wip/$branch" >/dev/null 2>&1 || true',
    '    rm -f .git/tensorlake-wip-tree',
    '    echo TENSORLAKE_WIP_CLEARED',
    '  else',
    '    echo TENSORLAKE_WIP_CLEAN',
    '  fi',
    '  exit 0',
    'fi',
    'GIT_INDEX_FILE="$(mktemp)" || exit 1',
    'export GIT_INDEX_FILE',
    'git read-tree HEAD || exit 1',
    'git add -A || exit 1',
    'tree="$(git write-tree)" || exit 1',
    'rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE',
    `if [ "$tree" = "$(git rev-parse 'HEAD^{tree}')" ]; then echo TENSORLAKE_WIP_CLEAN; exit 0; fi`,
    'if [ "$tree" = "$(cat .git/tensorlake-wip-tree 2>/dev/null)" ]; then echo TENSORLAKE_WIP_UNCHANGED; exit 0; fi',
    `commit="$(git commit-tree "$tree" -p HEAD -m 'Uncommitted sandbox changes (captured by tensorlake-opencode)')" || exit 1`,
    'git push --quiet origin "+$commit:refs/tensorlake-wip/$branch" || exit 1',
    `printf '%s\\n' "$tree" > .git/tensorlake-wip-tree`,
    'echo TENSORLAKE_WIP_PUSHED',
  ].join('\n')
  const result = await client.executeCommand(sandboxId, script, '/', 120_000)
  if (result.exitCode !== 0) {
    throw new Error(`wip capture failed (exit ${result.exitCode}): ${redactAuth(result.stderr || result.stdout)}`)
  }
  if (result.stdout.includes('TENSORLAKE_WIP_PUSHED')) return 'pushed'
  if (result.stdout.includes('TENSORLAKE_WIP_UNCHANGED')) return 'unchanged'
  if (result.stdout.includes('TENSORLAKE_WIP_CLEARED')) return 'cleared'
  if (result.stdout.includes('TENSORLAKE_WIP_SKIPPED')) return 'skipped'
  return 'clean'
}

/**
 * Recursively collect files to upload (remote path -> absolute local path)
 * plus every path that still exists locally, uploaded or not. Deletion
 * propagation must key off `present`, not `files`: a path can be skipped from
 * the upload (oversized, symlink, unreadable) while very much still existing.
 */
function collectFiles(worktree: string): { files: Record<string, string>; present: Set<string> } {
  const files: Record<string, string> = {}
  const present = new Set<string>()
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const localPath = join(dir, entry)
      const remotePath = prefix ? posix.join(prefix, entry) : entry
      let st
      try {
        st = lstatSync(localPath)
      } catch {
        // Unreadable is not deleted — keep it out of the upload but never let
        // its absence from `files` be read as a local deletion.
        present.add(remotePath)
        continue
      }
      if (st.isSymbolicLink()) {
        present.add(remotePath)
        continue
      }
      if (st.isDirectory()) {
        walk(localPath, remotePath)
      } else if (st.isFile()) {
        present.add(remotePath)
        if (st.size > MAX_FILE_BYTES) {
          logger.warn(`Skipping ${localPath} (${st.size} bytes > ${MAX_FILE_BYTES})`)
          continue
        }
        files[remotePath] = localPath
      }
    }
  }
  walk(worktree, '')
  return { files, present }
}

/**
 * Ensure the project's cloud volume exists and holds the current worktree
 * content. Returns the mount spec for the sandbox. Sandbox mounts address
 * volumes by their filesystem name. `manifestDir` is a laptop-local directory
 * where the record of uploaded paths is kept between syncs.
 */
export async function ensureVolumeWithProject(
  apiKey: string,
  worktree: string,
  projectId: string,
  mountPath: string,
  manifestDir: string,
): Promise<FileSystemMount> {
  const name = syncResourceName(projectId)
  const options = await cloudOptions(apiKey)
  const fsClient = new FilesystemClient(options)
  let fs
  try {
    fs = await fsClient.get(name)
  } catch {
    logger.info(`Creating cloud volume ${name}`)
    fs = await fsClient.create(name)
  }

  const { files, present } = collectFiles(worktree)
  const count = Object.keys(files).length
  const manifestPath = syncManifestPath(manifestDir, name)
  const manifest = readVolumeManifest(manifestPath)
  const stale = staleRemotePaths(manifest.paths, present)
  logger.info(`Uploading ${count} files from ${worktree} to volume ${name}`)
  let version: string | null = null
  if (count > 0) {
    version = (await fs.writeFilesFromPaths(files, 'Sync from OpenCode')).versionId
  }

  // Drop previously uploaded paths that no longer exist locally, so local
  // deletions propagate to later sandboxes. Non-fatal: the uploads above
  // already landed, and paths that fail to delete stay in the manifest so the
  // deletion is retried on the next sync.
  let undeleted: string[] = []
  if (stale.length > 0) {
    try {
      logger.info(`Removing ${stale.length} locally deleted files from volume ${name}`)
      version = (await fs.writeFiles({}, 'Sync from OpenCode (remove deleted files)', stale)).versionId
      for (const path of stale) {
        delete manifest.files[path]
        delete manifest.localHash[path]
      }
    } catch (err) {
      logger.warn(`Failed to remove deleted files from volume ${name}: ${err}`)
      undeleted = stale
    }
  }

  // Scrub the manifest older versions wrote into the volume root, where every
  // sandbox agent could see and commit it.
  try {
    version = (await fs.deleteFile(LEGACY_VOLUME_MANIFEST_PATH, 'Remove legacy sync manifest')).versionId
  } catch {
    // already gone — the common case
  }

  // Content hashes of what was just uploaded: sync-back uses them to tell
  // "the user changed this file since" apart from "safe to overwrite".
  for (const [remotePath, localPath] of Object.entries(files)) {
    try {
      manifest.localHash[remotePath] = sha1File(localPath)
    } catch (err) {
      logger.warn(`Could not hash ${localPath}: ${err}`)
    }
  }

  // Record the volume's content ids at this version as the sync-back
  // baseline. Anything the volume holds right now is treated as already
  // seen — which is why callers must download pending agent changes BEFORE
  // uploading. A failed walk keeps the old baseline (less pruning, no harm).
  try {
    if (version === null) version = (await fs.status()).versionId
    if (version) {
      const tree = await walkVolumeTree(fs, version, manifest)
      manifest.files = tree.files
      manifest.dirs = tree.dirs
      manifest.versionId = version
    }
  } catch (err) {
    manifest.versionId = undefined
    logger.warn(`Could not record volume baseline for ${name}: ${err}`)
  }

  manifest.paths = [...Object.keys(files), ...undeleted]
  writeVolumeManifest(manifestPath, manifest)

  return { fileSystemId: name, mountPath }
}

export type VolumeSyncBack = { downloaded: number; conflicts: string[]; deletedRemotely: number }

/**
 * Download files the agent changed on the project's cloud volume into the
 * local worktree. One `status()` call answers "anything new?"; a changed head
 * is diffed with a tree walk that prunes every directory whose server-side
 * contentId is unchanged. A local file is only ever overwritten when its
 * content still matches what the last sync recorded (`localHash`) — a file
 * the user edited too is skipped and reported as a conflict, and files
 * deleted on the volume are never deleted locally.
 */
export async function syncBackFromVolume(
  apiKey: string,
  worktree: string,
  projectId: string,
  manifestDir: string,
): Promise<VolumeSyncBack> {
  const none: VolumeSyncBack = { downloaded: 0, conflicts: [], deletedRemotely: 0 }
  const name = syncResourceName(projectId)
  const manifestPath = syncManifestPath(manifestDir, name)
  const manifest = readVolumeManifest(manifestPath)
  const fsClient = new FilesystemClient(await cloudOptions(apiKey))
  let fs
  try {
    fs = await fsClient.get(name)
  } catch {
    // No volume yet — nothing to pull.
    return none
  }
  const head = (await fs.status()).versionId
  if (!head || head === manifest.versionId) return none

  const tree = await walkVolumeTree(fs, head, manifest)
  let downloaded = 0
  const conflicts: string[] = []
  for (const entry of tree.changed) {
    if (!isSafeRelativePath(entry.path)) {
      logger.warn(`Sync-back: refusing unsafe path from volume ${name}: ${entry.path}`)
      continue
    }
    if (entry.size !== null && entry.size > MAX_FILE_BYTES) {
      logger.warn(`Sync-back: skipping ${entry.path} (${entry.size} bytes > ${MAX_FILE_BYTES})`)
      continue
    }
    const localPath = join(worktree, entry.path)
    if (existsSync(localPath)) {
      const recorded = manifest.localHash[entry.path]
      let current: string
      try {
        current = sha1File(localPath)
      } catch {
        // Unreadable, or a directory now sits where a file was — hands off.
        conflicts.push(entry.path)
        continue
      }
      if (recorded === undefined || current !== recorded) {
        conflicts.push(entry.path)
        continue
      }
    }
    const data = await fs.readFile(entry.path, head)
    if (data.byteLength > MAX_FILE_BYTES) {
      logger.warn(`Sync-back: skipping ${entry.path} (${data.byteLength} bytes > ${MAX_FILE_BYTES})`)
      continue
    }
    mkdirSync(dirname(localPath), { recursive: true })
    writeFileSync(localPath, Buffer.from(data))
    if (entry.executable) chmodSync(localPath, 0o755)
    manifest.localHash[entry.path] = createHash('sha1').update(Buffer.from(data)).digest('hex')
    downloaded++
  }

  // Files deleted on the volume: forget their sync state but keep the local
  // copy — deleting local files behind the user's back is not worth the risk.
  let deletedRemotely = 0
  for (const path of Object.keys(manifest.files)) {
    if (!(path in tree.files)) {
      deletedRemotely++
      delete manifest.localHash[path]
      logger.info(`Sync-back: ${path} was deleted on volume ${name}; the local copy was kept`)
    }
  }

  manifest.files = tree.files
  manifest.dirs = tree.dirs
  manifest.versionId = head
  writeVolumeManifest(manifestPath, manifest)
  return { downloaded, conflicts, deletedRemotely }
}

type VolumeTree = { files: Record<string, string>; dirs: Record<string, string>; changed: FileEntry[] }

/**
 * List the volume's tree at one pinned version, skipping every directory
 * whose contentId matches the previous walk (its old entries are copied
 * forward), regenerable SKIP_DIRS, and symlinks. `changed` holds the file
 * entries whose contentId moved off the previous baseline.
 */
async function walkVolumeTree(
  fs: { listFiles(dirPath?: string, version?: string): Promise<FileEntry[]> },
  version: string,
  prev: { files: Record<string, string>; dirs: Record<string, string> },
): Promise<VolumeTree> {
  const files: Record<string, string> = {}
  const dirs: Record<string, string> = {}
  const changed: FileEntry[] = []
  const copyForward = (dirPath: string) => {
    const prefix = `${dirPath}/`
    for (const [path, id] of Object.entries(prev.files)) if (path.startsWith(prefix)) files[path] = id
    for (const [path, id] of Object.entries(prev.dirs)) if (path.startsWith(prefix)) dirs[path] = id
  }
  const stack = ['']
  while (stack.length > 0) {
    const dir = stack.pop()!
    const entries = await fs.listFiles(dir === '' ? undefined : dir, version)
    for (const entry of entries) {
      if (entry.kind === 'symlink') continue
      if (entry.kind === 'directory') {
        dirs[entry.path] = entry.contentId
        if (SKIP_DIRS.has(entry.name)) continue
        if (prev.dirs[entry.path] === entry.contentId) copyForward(entry.path)
        else stack.push(entry.path)
      } else {
        files[entry.path] = entry.contentId
        if (prev.files[entry.path] !== entry.contentId) changed.push(entry)
      }
    }
  }
  return { files, dirs, changed }
}

function sha1File(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

/**
 * Confirm a filesystem exists in this project before it is attached anywhere.
 * Any failure to confirm blocks the attach: a wrong or unverifiable name costs
 * the whole sandbox, while a blocked sync only leaves the workspace empty and
 * is retried on the next turn.
 */
async function assertFileSystemExists(apiKey: string, name: string): Promise<void> {
  const fsClient = new FilesystemClient(await cloudOptions(apiKey))
  try {
    await fsClient.get(name)
  } catch (err: any) {
    throw new Error(
      `Refusing to attach filesystem ${name}: it could not be confirmed to exist in this project (${err?.message ?? err}).`,
    )
  }
}

/**
 * Laptop-local record of a volume's sync state: `paths` drives deletion
 * propagation on upload (as before); `versionId`/`files`/`dirs` are the
 * volume-side contentId baseline for sync-back; `localHash` is the sha1 each
 * synced file had locally, the guard against overwriting a user edit.
 */
type VolumeManifest = {
  paths: string[]
  versionId?: string
  files: Record<string, string>
  dirs: Record<string, string>
  localHash: Record<string, string>
}

function syncManifestPath(manifestDir: string, volumeName: string): string {
  return join(manifestDir, `${volumeName}.sync-manifest.json`)
}

function stringRecord(value: unknown): Record<string, string> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function readVolumeManifest(manifestPath: string): VolumeManifest {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Partial<VolumeManifest>
    return {
      // first sync, or a missing/corrupt manifest — never guess at deletions
      paths: Array.isArray(parsed.paths) ? parsed.paths.filter((p): p is string => typeof p === 'string') : [],
      versionId: typeof parsed.versionId === 'string' ? parsed.versionId : undefined,
      files: stringRecord(parsed.files),
      dirs: stringRecord(parsed.dirs),
      localHash: stringRecord(parsed.localHash),
    }
  } catch {
    return { paths: [], files: {}, dirs: {}, localHash: {} }
  }
}

function writeVolumeManifest(manifestPath: string, manifest: VolumeManifest): void {
  try {
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, paths: [...new Set(manifest.paths)].sort() }))
  } catch (err) {
    logger.warn(`Failed to write sync manifest ${manifestPath}: ${err}`)
  }
}

// Deletion paths are sent to the volume API verbatim, so accept only plain
// relative paths — no absolute paths, no `.`/`..` segments, no backslashes.
function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Previously uploaded paths that have since been deleted locally. Computed
 * against everything still present in the worktree (not just the uploaded
 * set), so files skipped from an upload are never treated as deleted, and
 * only from the manifest of past uploads, so files created by agents inside
 * the mounted volume are never touched. Paths now under SKIP_DIRS are also
 * left alone — the sandbox may own them (e.g. an agent-built dist/).
 */
function staleRemotePaths(previous: string[], present: Set<string>): string[] {
  return previous.filter(
    (path) =>
      isSafeRelativePath(path) &&
      !present.has(path) &&
      !path.split('/').some((segment) => SKIP_DIRS.has(segment)),
  )
}

/** Attach the project volume to an already-running sandbox if not mounted. */
export async function ensureVolumeMounted(
  client: TensorlakeClient,
  mount: FileSystemMount,
  sandboxId: string,
): Promise<void> {
  const mounts = await client.listSandboxFileSystems(sandboxId)
  if (!mounts.some((m) => m.mountPath === mount.mountPath)) {
    // Attaching a filesystem the project does not have terminates the sandbox
    // — the guest dies instead of the attach call failing — so the name is
    // confirmed before it is ever sent to a live sandbox.
    await assertFileSystemExists(client.getApiKey(), mount.fileSystemId)
    logger.info(`Attaching volume ${mount.fileSystemId} to sandbox ${sandboxId} at ${mount.mountPath}`)
    await client.attachFileSystem(sandboxId, mount.fileSystemId, mount.mountPath)
  }
  // Both attachFileSystem and the control plane's mount listing reflect
  // control-plane state; the guest materializes the mount asynchronously on
  // the dataplane. Callers mark the sandbox synced and run tools with
  // mountPath as cwd immediately after, so always wait for the guest to see a
  // real mount — including when the control plane already listed it.
  await waitForGuestMount(client, sandboxId, mount.mountPath)
}

async function waitForGuestMount(
  client: TensorlakeClient,
  sandboxId: string,
  path: string,
  timeoutMs = 30_000,
  probeTimeoutMs = 5_000,
): Promise<void> {
  // `test -d` is not enough here: the sync-failure fallback mkdirs a plain
  // directory at this exact path, which would satisfy it while the volume is
  // not mounted at all. Require the path to be an actual mountpoint.
  const probe = `mountpoint -q '${path}' 2>/dev/null || awk -v p='${path}' '$2 == p { found = 1 } END { exit !found }' /proc/mounts`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const check = await client.executeCommand(sandboxId, probe, '/', probeTimeoutMs)
      if (check.exitCode === 0) return
    } catch (err) {
      logger.warn(`Mount readiness check failed: ${err}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Volume mount at ${path} did not become visible in the sandbox within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
