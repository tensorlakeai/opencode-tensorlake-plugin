import type { PluginInput } from '@opencode-ai/plugin'
import { logger } from './logger.js'

/** Stop walking the parent chain after this many hops (corrupt data guard). */
const MAX_DEPTH = 16

/**
 * Maps an OpenCode session to the session that owns its sandbox.
 *
 * A subagent (the `task` tool) runs in its own child session with its own
 * session id. Giving each child its own sandbox would give it its own copy of
 * the workspace: the parent would never see the child's edits. So every
 * session in a tree shares the root session's sandbox, exactly as local
 * subagents share the user's working tree.
 *
 * Links are learned from `session.created` / `session.deleted` payloads, which
 * carry the whole session object, and only fall back to a lookup when a
 * session was created before this process started. A session the server cannot
 * describe is treated as its own root — the pre-0.3.0 behaviour.
 */
export class SessionTree {
  /** sessionId -> parent id, or null for "this session is a root". */
  private readonly parent = new Map<string, string | null>()
  /** In-flight lookups, so N concurrent tool calls cost one round trip. */
  private readonly inflight = new Map<string, Promise<string | null>>()

  /** Record a link that arrived with an event payload; saves a lookup later. */
  note(sessionId: string | undefined, parentId: string | undefined | null): void {
    if (!sessionId) return
    this.parent.set(sessionId, parentId && parentId !== sessionId ? parentId : null)
  }

  /** Whether the session's parent is already known (no I/O needed). */
  knows(sessionId: string): boolean {
    return this.parent.has(sessionId)
  }

  /**
   * The root ancestor of `sessionId` — the session whose sandbox it uses.
   * Returns `sessionId` itself for a root session, or when the chain cannot
   * be resolved.
   */
  async root(sessionId: string, pluginCtx?: PluginInput): Promise<string> {
    let current = sessionId
    const seen = new Set([current])
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const parentId = await this.lookup(current, pluginCtx)
      if (!parentId || seen.has(parentId)) break
      seen.add(parentId)
      current = parentId
    }
    return current
  }

  /**
   * Root ancestor from cache alone — never does I/O, so an unknown session
   * answers itself. For paths that cannot await (or that run after the session
   * is gone, where a lookup would 404 anyway).
   */
  rootCached(sessionId: string): string {
    let current = sessionId
    const seen = new Set([current])
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const parentId = this.parent.get(current)
      if (!parentId || seen.has(parentId)) break
      seen.add(parentId)
      current = parentId
    }
    return current
  }

  /** Forget a session and any children pointing at it. */
  forget(sessionId: string): void {
    this.parent.delete(sessionId)
    for (const [id, parentId] of this.parent) {
      if (parentId === sessionId) this.parent.delete(id)
    }
  }

  private lookup(sessionId: string, pluginCtx?: PluginInput): Promise<string | null> | string | null {
    const known = this.parent.get(sessionId)
    if (known !== undefined) return known
    const sessions = pluginCtx?.client?.session
    if (!sessions?.get) return null
    const existing = this.inflight.get(sessionId)
    if (existing) return existing
    const run = (async (): Promise<string | null> => {
      try {
        const response: any = await sessions.get({ path: { id: sessionId } })
        const info = response?.data ?? response
        // A session that resolves to itself, or to nothing, is a root.
        const parentId =
          typeof info?.parentID === 'string' && info.parentID && info.parentID !== sessionId ? info.parentID : null
        this.parent.set(sessionId, parentId)
        return parentId
      } catch (err) {
        // Deliberately not cached: a transient failure must not pin the
        // session as a root for the rest of the process.
        logger.warn(`Could not resolve the parent of session ${sessionId}: ${err}`)
        return null
      } finally {
        this.inflight.delete(sessionId)
      }
    })()
    this.inflight.set(sessionId, run)
    return run
  }
}
