import type { PluginInput } from '@opencode-ai/plugin'
import type { ExperimentalChatSystemTransformInput, ExperimentalChatSystemTransformOutput } from '../core/types.js'
import { resolveSyncMode, resolveSyncBranch } from '../core/project-sync.js'
import { resolveProjectContext } from '../core/project-context.js'

export async function systemPromptTransform(ctx: PluginInput, workDir: string, projectDir: string) {
  const { worktree } = resolveProjectContext(ctx)
  const mode = resolveSyncMode(worktree)
  return async (_input: ExperimentalChatSystemTransformInput, output: ExperimentalChatSystemTransformOutput) => {
    const lines = [
      '## Tensorlake Sandbox Integration',
      'This session is running inside a Tensorlake sandbox.',
      'All bash commands, file reads/writes, and searches run inside the sandbox.',
      'Do NOT use paths from the host system.',
      "For long-running commands (servers, watchers), use bash with background=true; check on them with bash_output and stop them with bash_kill.",
    ]
    if (mode === 'git') {
      // Resolved per message, not at plugin startup: the user can switch
      // local branches between turns and later syncs follow the new branch.
      const branch = await resolveSyncBranch(worktree)
      lines.push(
        `The local project is synced into the sandbox as a git clone at: ${projectDir} (branch: ${branch})`,
        `Work in ${projectDir} on branch '${branch}'. Commit and push to 'origin ${branch}' to persist changes; pushed commits are pulled back into the user's local checkout automatically.`,
        "If the user mentions local edits, commits, or a branch switch you cannot see, run the 'sync' tool to bring their latest local state into the sandbox.",
      )
    } else if (mode === 'mount') {
      lines.push(
        `The user's local folder and this sandbox mount the same Tensorlake filesystem; it is at: ${projectDir}`,
        `Work in ${projectDir}. Writes are saved automatically and appear in the user's local folder within about a second, so the user may be editing the same files — prefer touching only what you were asked to change.`,
      )
    } else if (mode === 'volume') {
      lines.push(
        `The local project is mounted into the sandbox on a cloud volume at: ${projectDir}`,
        `Work in ${projectDir}. Writes there are persisted automatically.`,
        "If the user mentions local edits you cannot see, run the 'sync' tool to upload their latest local files (it replaces the volume's copies of those files).",
      )
    } else {
      lines.push(`The working directory is: ${workDir}`, `Put all project files in ${workDir}.`)
    }
    output.system.push(lines.join('\n'))
  }
}
