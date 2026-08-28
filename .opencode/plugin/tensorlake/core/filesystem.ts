import { FilesystemClient } from 'tensorlake'
import type { FileSystemMount } from 'tensorlake'
import { logger } from './logger.js'
import { shellQuote } from './shell.js'
import type { TensorlakeClient } from './client.js'

function cloudOptions(apiKey: string) {
  const apiUrl = process.env.TENSORLAKE_API_URL
  return { apiKey, ...(apiUrl ? { apiUrl } : {}) }
}

/**
 * The Tensorlake filesystem to attach to every sandbox, from configuration.
 * TENSORLAKE_FILESYSTEM (or the `filesystem` plugin option) names it; the
 * default mount path is the sandbox working directory, so everything the
 * agent writes persists across sandboxes and sessions. Set
 * TENSORLAKE_FILESYSTEM_PATH (or the `filesystemPath` option) to mount it
 * somewhere else. No filesystem is attached when nothing is configured.
 */
export function resolveFileSystemMount(
  options: Record<string, unknown> | undefined,
  workDir: string,
): FileSystemMount | undefined {
  const name =
    process.env.TENSORLAKE_FILESYSTEM ??
    (typeof options?.filesystem === 'string' ? options.filesystem : undefined)
  if (!name?.trim()) return undefined
  const mountPath =
    process.env.TENSORLAKE_FILESYSTEM_PATH ??
    (typeof options?.filesystemPath === 'string' ? options.filesystemPath : undefined) ??
    workDir
  return { fileSystemId: name.trim(), mountPath }
}

/**
 * Confirm a filesystem exists in this project before it is attached anywhere.
 * Any failure to confirm blocks the attach: attaching a wrong name to a live
 * sandbox terminates it, so a mistyped TENSORLAKE_FILESYSTEM must surface as
 * an error, never reach the sandbox.
 */
export async function assertFileSystemExists(apiKey: string, name: string): Promise<void> {
  const fsClient = new FilesystemClient(cloudOptions(apiKey))
  try {
    await fsClient.get(name)
  } catch (err: any) {
    throw new Error(
      `Refusing to attach filesystem ${name}: it could not be confirmed to exist in this project (${err?.message ?? err}). ` +
        'Create it with `tl fs create <name>` or fix TENSORLAKE_FILESYSTEM / the `filesystem` plugin option.',
    )
  }
}

/**
 * Make sure the configured filesystem is attached to the sandbox and visible
 * to the guest. New sandboxes get the filesystem at create time (Sandbox.create
 * fileSystems); this covers reconnected or resumed sandboxes, and waits in
 * both cases for the guest to materialize the mount before tools run in it.
 */
export async function ensureFileSystemMounted(
  client: TensorlakeClient,
  mount: FileSystemMount,
  sandboxId: string,
): Promise<void> {
  const mounts = await client.listSandboxFileSystems(sandboxId)
  const existing = mounts.find((m) => m.mountPath === mount.mountPath)
  if (existing && existing.fileSystemId !== mount.fileSystemId) {
    // A different filesystem occupies the path (the configuration changed
    // between runs). Detach it first — leaving it would run tools against the
    // old storage while the plugin reports the configured filesystem as
    // mounted.
    logger.info(
      `Detaching filesystem ${existing.fileSystemId} from sandbox ${sandboxId} at ${mount.mountPath} (expected ${mount.fileSystemId})`,
    )
    await client.detachFileSystem(sandboxId, mount.mountPath)
    // The guest unmounts asynchronously; the readiness probe below cannot
    // tell filesystems apart, so wait until the old mount is really gone
    // before it can be mistaken for the new one.
    await waitForGuestMount(client, sandboxId, mount.mountPath, { mounted: false })
  }
  if (!existing || existing.fileSystemId !== mount.fileSystemId) {
    // Attaching a filesystem the project does not have terminates the sandbox
    // — the guest dies instead of the attach call failing — so the name is
    // confirmed before it is ever sent to a live sandbox.
    await assertFileSystemExists(client.getApiKey(), mount.fileSystemId)
    logger.info(`Attaching filesystem ${mount.fileSystemId} to sandbox ${sandboxId} at ${mount.mountPath}`)
    await client.attachFileSystem(sandboxId, mount.fileSystemId, mount.mountPath)
  }
  // Both attachFileSystem and the control plane's mount listing reflect
  // control-plane state; the guest materializes the mount asynchronously on
  // the dataplane. Callers run tools with mountPath as cwd immediately after,
  // so always wait for the guest to see a real mount — including when the
  // control plane already listed it.
  await waitForGuestMount(client, sandboxId, mount.mountPath)
}

async function waitForGuestMount(
  client: TensorlakeClient,
  sandboxId: string,
  path: string,
  opts: { mounted?: boolean; timeoutMs?: number; probeTimeoutMs?: number } = {},
): Promise<void> {
  const { mounted = true, timeoutMs = 30_000, probeTimeoutMs = 5_000 } = opts
  // `test -d` is not enough here: the workspace mkdir creates a plain
  // directory at this exact path, which would satisfy it while the filesystem
  // is not mounted at all. Require the path to be an actual mountpoint.
  const quoted = shellQuote(path)
  const probe = `mountpoint -q ${quoted} 2>/dev/null || awk -v p=${quoted} '$2 == p { found = 1 } END { exit !found }' /proc/mounts`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const check = await client.executeCommand(sandboxId, probe, '/', probeTimeoutMs)
      if ((check.exitCode === 0) === mounted) return
    } catch (err) {
      logger.warn(`Mount readiness check failed: ${err}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Filesystem mount at ${path} did not become ${mounted ? 'visible' : 'unmounted'} in the sandbox within ${timeoutMs}ms`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
