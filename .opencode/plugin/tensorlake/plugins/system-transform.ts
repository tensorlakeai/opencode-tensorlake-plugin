import type { PluginInput } from '@opencode-ai/plugin'
import type { ExperimentalChatSystemTransformInput, ExperimentalChatSystemTransformOutput } from '../core/types.js'
import { gitRepoUrl } from '../core/git-bootstrap.js'
import { logger } from '../core/logger.js'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

export async function systemPromptTransform(_ctx: PluginInput, sessionManager: TensorlakeSessionManager) {
  return async (_input: ExperimentalChatSystemTransformInput, output: ExperimentalChatSystemTransformOutput) => {
    const workDir = sessionManager.projectDir()
    const lines = [
      '## Tensorlake Sandbox Integration',
      'This session is running inside a Tensorlake sandbox.',
      'All bash commands, file reads/writes, and searches run inside the sandbox.',
      'Do NOT use paths from the host system.',
      `The working directory is: ${workDir}`,
    ]
    const mount = sessionManager.fileSystemMount()
    if (mount) {
      lines.push(
        `${mount.mountPath} is a persistent Tensorlake filesystem ('${mount.fileSystemId}'). ` +
          'Files written there survive sandbox deletion and are shared with every other sandbox that mounts the same filesystem.',
        `Put all project files in ${mount.mountPath}.`,
      )
    } else {
      lines.push(`Put all project files in ${workDir}.`)
    }
    const repo = sessionManager.gitRepoName()
    if (repo) {
      // Resolved per message rather than at startup: the API key may not be
      // stored yet when the plugin loads. gitRepoUrl caches per process.
      let url: string | undefined
      if (sessionManager.getClient().hasApiKey()) {
        try {
          url = await gitRepoUrl(sessionManager.getClient().getApiKey(), repo)
        } catch (err: any) {
          logger.warn(`Could not resolve the URL of git repository ${repo}: ${err?.message ?? err}`)
        }
      }
      lines.push(
        url
          ? `A Tensorlake-hosted git repository '${repo}' is available at ${url}. Git credentials and an identity are configured in the sandbox — clone it with \`git clone ${url}\`, then commit and push to persist work there.`
          : `A Tensorlake-hosted git repository '${repo}' is configured. Git credentials and an identity are set up in the sandbox, so you can clone, commit, and push to it.`,
      )
    }
    output.system.push(lines.join('\n'))
  }
}
