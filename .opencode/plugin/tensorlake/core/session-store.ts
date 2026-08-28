import { createHash } from 'crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { logger } from './logger.js'
import type { ProjectSessionData } from './types.js'

/** How old a lock file must be before its holder's liveness is checked. */
const LOCK_STALE_MS = 5_000
/**
 * A lock older than this is broken even when its recorded PID looks alive.
 * The operating system reuses PIDs, so the liveness check can vouch for a
 * process that is not the holder; without this cap such a lock would never
 * break and the store could never be written again.
 */
const LOCK_STALE_HARD_MS = 60_000
/**
 * How long to wait for another process to release the lock. Longer than
 * LOCK_STALE_MS on purpose: a holder that died is broken as stale within the
 * wait, so acquisition only fails when a live process holds the lock far
 * beyond its microsecond critical section — or the lock file cannot be
 * created at all.
 */
const LOCK_WAIT_MS = LOCK_STALE_MS + 1_000
const LOCK_RETRY_MS = 5

/** Project ids that are safe to use as a file name unchanged. */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/**
 * The session-to-sandbox mapping of one project, on disk.
 *
 * The file is the only record of the sandboxes this machine is paying for, so
 * every write is atomic (temporary file plus rename), every read-modify-write
 * runs under a lock that other OpenCode processes honour, and a file that does
 * not parse is set aside instead of discarded.
 */
export class SessionStore {
  constructor(private readonly dir: string) {}

  /** The stored data, or null when there is none (or none that can be read). */
  read(projectId: string): ProjectSessionData | null {
    const path = this.pathFor(projectId)
    let raw: string
    try {
      if (!existsSync(path)) return null
      raw = readFileSync(path, 'utf-8')
    } catch (err) {
      logger.error(`Failed to read session store ${path}: ${err}`)
      return null
    }

    const data = parse(raw)
    if (data) return data
    this.quarantine(path)
    return null
  }

  /**
   * Apply `mutate` to the data on disk and store the result. Return false from
   * `mutate` to leave the file untouched.
   */
  update(projectId: string, worktree: string, mutate: (data: ProjectSessionData) => boolean | void): void {
    const path = this.pathFor(projectId)
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      logger.error(`Failed to create session store directory ${this.dir}: ${err}`)
      return
    }

    const lock = `${path}.lock`
    // Never modify the file without the lock: a read-modify-write built on a
    // stale copy erases another process's sessions, orphaning sandboxes that
    // keep costing money. This process's own mapping stays in the in-memory
    // cache, so the next update retries the write.
    if (!acquireLock(lock)) {
      logger.error(`Could not lock session store ${path}; skipping this update to protect concurrent writers`)
      return
    }
    try {
      // Read inside the lock. Another OpenCode process works on its own
      // sessions in this same file; a write built on a stale copy erases them.
      const data = this.read(projectId) ?? { projectId, worktree, sessions: {} }
      if (worktree) data.worktree = worktree
      if (mutate(data) === false) return
      // Another process breaks the lock if this one stalls past
      // LOCK_STALE_HARD_MS. A write after that would race the new holder and
      // erase its sessions, so confirm ownership right before the write.
      if (!ownsLock(lock)) {
        logger.error(`Lost session store lock ${lock} while updating; skipping this write to protect the new holder`)
        return
      }
      writeAtomic(path, JSON.stringify(data, null, 2))
    } catch (err) {
      logger.error(`Failed to save project data: ${err}`)
    } finally {
      releaseLock(lock)
    }
  }

  private pathFor(projectId: string): string {
    return join(this.dir, `${storageKey(projectId)}.json`)
  }

  /**
   * Keep an unreadable file. It holds the ids of sandboxes that are still
   * running; deleting it orphans them, and they keep costing money.
   */
  private quarantine(path: string): void {
    const kept = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, kept)
      logger.error(`Session store ${path} is unreadable; kept a copy at ${kept}`)
    } catch (err) {
      logger.error(`Session store ${path} is unreadable and could not be set aside: ${err}`)
    }
  }
}

/**
 * A file name for a project id. Ids come from OpenCode, so they can hold a
 * path separator or a leading dot; those would write outside the store
 * directory or hide the file, and are replaced by a stable hash.
 */
export function storageKey(projectId: string): string {
  if (SAFE_ID.test(projectId) && projectId.length <= 64) return projectId
  return `p-${createHash('sha1').update(projectId).digest('hex').slice(0, 16)}`
}

function parse(raw: string): ProjectSessionData | null {
  try {
    const data = JSON.parse(raw) as ProjectSessionData
    if (!data || typeof data !== 'object') return null
    if (!data.sessions || typeof data.sessions !== 'object') return null
    return data
  } catch {
    return null
  }
}

/**
 * Write through a temporary file in the same directory and rename over the
 * target. A crash then leaves either the old file or the new one, never a
 * half-written one.
 */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, contents)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // The temporary file stays behind; the next write replaces it.
    }
    throw err
  }
}

/**
 * Take the lock, or report false after the wait runs out. The caller must not
 * touch the file without it: an unlocked read-modify-write can erase another
 * process's sessions. Failure is exceptional — a dead holder is broken as
 * stale well within the wait.
 */
function acquireLock(lock: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid}`, { flag: 'wx' })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        logger.error(`Could not create session store lock ${lock}: ${err}`)
        return false
      }
      if (isStale(lock)) {
        // The process that took it died before it could clean up.
        try {
          rmSync(lock, { force: true })
        } catch {
          return false
        }
      }
      if (Date.now() >= deadline) {
        logger.warn(`Session store lock ${lock} is still held after ${LOCK_WAIT_MS}ms`)
        return false
      }
      sleep(LOCK_RETRY_MS)
    }
  }
}

function releaseLock(lock: string): void {
  // Only remove a lock this process still holds. After a long stall the lock
  // can belong to another process; deleting it would let a third writer in.
  if (!ownsLock(lock)) return
  try {
    rmSync(lock, { force: true })
  } catch (err) {
    logger.warn(`Failed to release session store lock ${lock}: ${err}`)
  }
}

/** True when the lock file still records this process as the holder. */
function ownsLock(lock: string): boolean {
  try {
    return readFileSync(lock, 'utf-8').trim() === `${process.pid}`
  } catch {
    return false
  }
}

function isStale(lock: string): boolean {
  let age: number
  try {
    age = Date.now() - statSync(lock).mtimeMs
  } catch {
    // Gone already, so it holds nothing back.
    return false
  }
  if (age <= LOCK_STALE_MS) return false
  if (age > LOCK_STALE_HARD_MS) return true
  // Age alone does not prove abandonment: a live holder can be paused or
  // wedged past the threshold, and stealing its lock puts two writers on the
  // same file. Only a lock whose holder is gone is stale.
  return !holderIsAlive(lock)
}

/** True when the PID recorded in the lock file is a live process. */
function holderIsAlive(lock: string): boolean {
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(lock, 'utf-8').trim(), 10)
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4))

/**
 * Wait without releasing the event loop; the lock is only held microseconds,
 * so contention normally resolves within a few retries. The full LOCK_WAIT_MS
 * is only ever blocked on when another live process is wedged inside its
 * critical section.
 */
function sleep(ms: number): void {
  Atomics.wait(SLEEP_SLOT, 0, 0, ms)
}
