import type { PluginInput } from '@opencode-ai/plugin'
import type { ExperimentalChatSystemTransformInput, ExperimentalChatSystemTransformOutput } from '../core/types.js'

export async function systemPromptTransform(ctx: PluginInput, workDir: string) {
  return async (_input: ExperimentalChatSystemTransformInput, output: ExperimentalChatSystemTransformOutput) => {
    output.system.push(
      [
        '## TensorLake Sandbox Integration',
        'This session is running inside a TensorLake sandbox.',
        `The working directory is: ${workDir}`,
        'All bash commands, file reads/writes, and searches run inside the sandbox.',
        `Put all project files in ${workDir}. Do NOT use paths from the host system.`,
        "For long-running commands (servers, watchers), use the 'background' option.",
      ].join('\n'),
    )
  }
}
