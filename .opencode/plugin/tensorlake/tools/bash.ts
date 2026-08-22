import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { TensorlakeSessionManager } from '../core/session-manager.js'

// Lines already returned per background process (keyed by sandboxId:pid),
// so bash_output only shows output produced since the previous call.
const outputOffsets = new Map<string, number>()

// With no stored offset (e.g. after a plugin restart) the whole buffer would
// count as "new"; cap the replay so a long-running server's log can't flood.
const MAX_REPLAY_LINES = 200

function offsetKey(sandboxId: string, pid: number): string {
  return `${sandboxId}:${pid}`
}

function describeStatus(pid: number, status: string, exitCode?: number, signal?: number): string {
  if (status === 'running') return `Background process ${pid} is running.`
  const detail =
    exitCode !== undefined ? ` with exit code ${exitCode}` : signal !== undefined ? ` by signal ${signal}` : ''
  return `Background process ${pid} has ${status}${detail}.`
}

export const bashTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Executes shell commands in a Tensorlake sandbox. Set background=true for long-running commands (servers, watchers); it returns a pid to use with bash_output and bash_kill.',
  args: {
    command: z.string(),
    background: z.boolean().optional(),
  },
  async execute(args: { command: string; background?: boolean }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const client = sessionManager.getClient()
    const workDir = sessionManager.projectDir(worktree)

    if (args.background) {
      const pid = await client.startBackgroundProcess(sandboxId, args.command, workDir)
      outputOffsets.set(offsetKey(sandboxId, pid), 0)
      return `Started background process with pid ${pid}. Use bash_output with pid=${pid} to read its output, bash_kill to stop it.`
    }

    const result = await client.executeCommand(sandboxId, args.command, workDir)
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    return `Exit code: ${result.exitCode}\n${output}`
  },
})

export const bashOutputTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Returns new output and status of a background process started with bash background=true. Only lines produced since the previous bash_output call for that pid are returned.',
  args: {
    pid: z.number().describe('Pid returned by bash when background=true'),
  },
  async execute(args: { pid: number }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const client = sessionManager.getClient()

    const key = offsetKey(sandboxId, args.pid)
    let status
    try {
      status = await client.getProcessStatus(sandboxId, args.pid)
    } catch (err: any) {
      outputOffsets.delete(key)
      return `No background process with pid ${args.pid} found in the sandbox (${err?.message ?? err}).`
    }
    const lines = await client.getProcessOutput(sandboxId, args.pid)
    const offset = outputOffsets.get(key)
    let fresh = lines.slice(offset ?? 0)
    let truncationNote = ''
    if (offset === undefined && fresh.length > MAX_REPLAY_LINES) {
      truncationNote = `(showing last ${MAX_REPLAY_LINES} of ${fresh.length} buffered lines)\n`
      fresh = fresh.slice(-MAX_REPLAY_LINES)
    }
    outputOffsets.set(key, lines.length)

    const header = describeStatus(status.pid, status.status, status.exitCode, status.signal)
    const body = fresh.length > 0 ? fresh.join('\n') : '(no new output)'
    return `${header}\n${truncationNote}${body}`
  },
})

export const bashKillTool = (
  sessionManager: TensorlakeSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Kills a background process started with bash background=true.',
  args: {
    pid: z.number().describe('Pid returned by bash when background=true'),
  },
  async execute(args: { pid: number }, ctx: ToolContext) {
    const { sandboxId } = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const client = sessionManager.getClient()
    await client.killProcess(sandboxId, args.pid)
    outputOffsets.delete(offsetKey(sandboxId, args.pid))
    return `Background process ${args.pid} killed.`
  },
})
