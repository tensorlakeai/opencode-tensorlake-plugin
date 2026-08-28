import { RepositoryClient } from 'tensorlake'
import { logger } from './logger.js'
import type { TensorlakeClient } from './client.js'

function cloudOptions(apiKey: string) {
  const apiUrl = process.env.TENSORLAKE_API_URL
  return { apiKey, ...(apiUrl ? { apiUrl } : {}) }
}

/**
 * The Tensorlake-hosted git repository to set up in every sandbox, from
 * configuration. TENSORLAKE_GIT_REPO (or the `gitRepo` plugin option) names
 * it. When set, the plugin creates the repository if it does not exist,
 * writes a scoped git credential and a fallback identity into the sandbox,
 * and tells the model the clone URL — so the agent can clone, commit, and
 * push to persist its work. Nothing is configured when unset.
 */
export function resolveGitRepo(options: Record<string, unknown> | undefined): string | undefined {
  const name =
    process.env.TENSORLAKE_GIT_REPO ?? (typeof options?.gitRepo === 'string' ? options.gitRepo : undefined)
  return name?.trim() || undefined
}

// Git tokens live about one hour; re-mint the sandbox's stored credential
// well before that so agent pushes keep working in long sessions.
export const GIT_CREDENTIAL_REFRESH_MS = 30 * 60 * 1000

// The repo's existence and clone URL, resolved once per process per
// (API URL, API key, repo). The key and URL are part of the cache key: a
// re-login to another Tensorlake project must not reuse the old project's URL.
const repoUrls = new Map<string, Promise<string>>()

function repoCacheKey(apiKey: string, repo: string): string {
  return `${process.env.TENSORLAKE_API_URL ?? ''}\0${apiKey}\0${repo}`
}

/**
 * The clone URL of the configured repository, creating the repository on
 * first use. Cached per process; a failure is not cached, so the next call
 * retries.
 */
export function gitRepoUrl(apiKey: string, repo: string): Promise<string> {
  const key = repoCacheKey(apiKey, repo)
  const existing = repoUrls.get(key)
  if (existing) return existing
  const run = (async () => {
    const repos = RepositoryClient.forCloud(cloudOptions(apiKey))
    try {
      try {
        await repos.info(repo)
      } catch {
        logger.info(`Creating hosted git repository ${repo}`)
        await repos.create(repo, { defaultBranch: 'main' })
      }
      return await repos.url(repo)
    } finally {
      repos.close()
    }
  })()
  repoUrls.set(key, run)
  run.catch(() => repoUrls.delete(key))
  return run
}

// Git credential store line for the repo, in git's expected
// https://user:token@host format.
async function credentialLine(apiKey: string, repo: string): Promise<string> {
  const repos = RepositoryClient.forCloud(cloudOptions(apiKey))
  try {
    const cred = await repos.credential(repo)
    const parsed = new URL(await repos.url(repo))
    return `${parsed.protocol}//${encodeURIComponent(cred.gitUsername)}:${encodeURIComponent(cred.token)}@${parsed.host}`
  } finally {
    repos.close()
  }
}

// Shell script that replaces only this host's line in the sandbox's
// ~/.git-credentials, keeping credentials the agent added for other remotes.
function credentialStoreScript(credLine: string): string {
  const host = credLine.slice(credLine.lastIndexOf('@') + 1)
  const hostPattern = host.replace(/[.[\]^$*\\]/g, '\\$&')
  return [
    'touch ~/.git-credentials',
    `grep -v '@${hostPattern}$' ~/.git-credentials > ~/.git-credentials.tmp || true`,
    `printf '%s\\n' '${credLine}' >> ~/.git-credentials.tmp`,
    'chmod 600 ~/.git-credentials.tmp',
    'mv ~/.git-credentials.tmp ~/.git-credentials',
  ].join('\n')
}

/**
 * Set up git in the sandbox for the configured repository: make sure the
 * repository exists, store a freshly minted credential for its host, and give
 * the sandbox a fallback identity so the agent can commit. Also used to
 * refresh the credential in long sessions (see GIT_CREDENTIAL_REFRESH_MS).
 * Only a Tensorlake credential scoped to this one repository enters the
 * sandbox — never the user's own git credentials or remotes.
 */
export async function bootstrapSandboxGit(
  client: TensorlakeClient,
  apiKey: string,
  sandboxId: string,
  repo: string,
): Promise<void> {
  await gitRepoUrl(apiKey, repo)
  const credLine = await credentialLine(apiKey, repo)
  const script = [
    'set -e',
    'git config --global credential.helper store',
    credentialStoreScript(credLine),
    `git config --global user.name >/dev/null 2>&1 || git config --global user.name 'OpenCode Agent'`,
    `git config --global user.email >/dev/null 2>&1 || git config --global user.email 'opencode-agent@tensorlake.ai'`,
  ].join('\n')
  const result = await client.executeCommand(sandboxId, script, '/', 30_000)
  if (result.exitCode !== 0) {
    throw new Error(`git bootstrap failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  }
}
