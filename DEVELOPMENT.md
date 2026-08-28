# Development

This guide is for people who work on the plugin itself. If you only want to use the plugin, read the [README](README.md).

## Local install

OpenCode can run the plugin from TypeScript source through its embedded Bun runtime.

Clone the repository:

```bash
git clone https://github.com/tensorlakeai/opencode-tensorlake-plugin ~/opencode-tensorlake-plugin
```

Point OpenCode at the plugin entry file in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///Users/your-username/opencode-tensorlake-plugin/.opencode/plugin/index.ts"
  ]
}
```

Two rules for local paths:

- The `file://` prefix is required. Without it, OpenCode treats the value as an npm package name.
- The path must point to the `.ts` entry file (`.opencode/plugin/index.ts`), not the repository root.

## Project structure

```
opencode-tensorlake-plugin/
├── package.json
├── tsconfig.json          # type-check config (no emit)
├── tsconfig.lib.json      # build config (emits to dist/)
└── .opencode/
    └── plugin/
        ├── index.ts                          # re-exports default plugin
        └── tensorlake/
            ├── index.ts                      # plugin factory
            ├── tools.ts                      # assembles all tools
            ├── core/
            │   ├── client.ts                 # Tensorlake SDK client wrapper
            │   ├── credentials.ts            # API key resolution (auth.json + env)
            │   ├── filesystem.ts             # optional persistent filesystem attach
            │   ├── git-bootstrap.ts          # optional hosted git repo credentials
            │   ├── glob-match.ts             # glob pattern to RegExp compiler
            │   ├── logger.ts                 # file-based logger with rotation
            │   ├── project-context.ts        # resolves the local project identity
            │   ├── session-manager.ts        # sandbox lifecycle management
            │   ├── session-store.ts          # persistent session -> sandbox mapping
            │   ├── session-tree.ts           # maps subagent sessions to their root
            │   ├── shell.ts                  # shell quoting helper
            │   ├── toast.ts                  # TUI toast queue
            │   └── types.ts                  # shared type definitions
            ├── tools/
            │   ├── apply-patch.ts
            │   ├── bash.ts
            │   ├── read.ts
            │   ├── write.ts
            │   ├── edit.ts
            │   ├── multiedit.ts
            │   ├── ls.ts
            │   ├── glob.ts
            │   └── grep.ts
            └── plugins/
                ├── auth.ts                   # registers Tensorlake in opencode auth login
                ├── custom-tools.ts           # wires tools into plugin return value
                ├── session-events.ts         # handles session created/deleted events
                └── system-transform.ts       # injects sandbox context into system prompt
```

## Build and type-check

```bash
npm run type-check
npm run build
```

The build emits to `dist/` with declaration files. `tsconfig.lib.json` sets `rootDir` to `.opencode/plugin`, so the output mirrors that structure. The `main` field in `package.json` points to `dist/index.js`.

## Unit tests

```bash
npm test
```

Runs `test/*.test.ts` with the Node test runner (via `tsx`). No Tensorlake key is needed. The tests cover the logic that does not need a sandbox:

- `apply-patch` — patch parsing, hunk matching, and the tool's all-or-nothing commit. The tool test runs the real shell scripts in a temp directory and checks that a failed step restores every file.
- `glob-match` — glob to RegExp, and the literal prefix used to narrow the search.
- `session-tree` — subagent to root resolution, cached lookups, cycles, failures.
- `session-store` — atomic writes, quarantine of corrupt files, stale-lock recovery, three processes writing at once.
- `options` — `filesystem` / `gitRepo` resolution and env precedence; `shellQuote`.

One test waits about 6 s on purpose (a lock held by a live process).

## Manual tests

Everything below needs a real sandbox and a Tensorlake key. Run it before a release.

### Auth flow

1. Make sure `TENSORLAKE_API_KEY` is **not** exported and no `tensorlake` entry exists in `~/.local/share/opencode/auth.json`.
2. Start OpenCode and ask the model to run a command. The tool call fails with a **"Tensorlake login required"** toast.
3. Run `opencode auth login` and select **Tensorlake**. A hint shows where to get a key (press Enter to continue), then paste a project API key at the masked prompt. The prompt does not validate the key; a non-project key triggers a **"Check your Tensorlake API key"** warning toast on the first tool call.
4. Retry the tool call in the same session — no restart needed. The sandbox is created.

### Smoke test

1. Log in once, then start OpenCode in a project directory.
2. No sandbox exists yet — sandboxes are created on the first intercepted tool call, not at startup. Confirm the plugin loaded:

   ```bash
   tail -f ~/.local/share/opencode/log/tensorlake.log
   ```

   On startup you see one line:

   ```
   [...] [INFO] OpenCode started with Tensorlake plugin
   ```

   If the file does not exist, the plugin never loaded — see [Plugin not loading](#plugin-not-loading).

3. Ask the model to run a command. The first tool call provisions the sandbox; a **"Sandbox created"** toast appears, and the log shows:

   ```
   [...] [INFO] Creating new sandbox for session abc123
   [...] [INFO] Sandbox created sandbox-xyz in 2300ms
   ```

### Bash

```
Run: echo "hello from sandbox" && uname -a
```

The output shows Linux kernel information from the sandbox VM, not your local machine.

### File read/write

```
Write the text "Hello Tensorlake" to /tmp/workspace/test.txt, then read it back.
```

The model calls `write` then `read`, both routed to the sandbox via the SDK. The response echoes `Hello Tensorlake`.

### Directory listing

```
List the files in /tmp/workspace
```

This triggers the `ls` tool, which calls `sandbox.listDirectory()` via the SDK.

### Sandbox deletion

Delete the OpenCode session from the session list. The plugin handles `session.deleted` and terminates the sandbox. Confirm in the log:

```
[...] [INFO] Deleting sandbox sandbox-xyz for session abc123
[...] [INFO] Sandbox sandbox-xyz deleted
```

### Subagent sandbox sharing

1. In a session with a sandbox, ask the model to use the `task` tool (for example, `Use a subagent task to create /tmp/workspace/from-subagent.txt`).
2. After the task completes, ask the parent to read the file. It sees the subagent's write — both ran in the same sandbox.
3. The log shows the subagent session resolved to the root session, and no second `Creating new sandbox` line appears.

### Persistent filesystem

1. Create a filesystem: `tl fs create test-fs`.
2. Add `{ "filesystem": "test-fs" }` to the plugin options (or export `TENSORLAKE_FILESYSTEM=test-fs`) and restart OpenCode.
3. Ask the model to write a file in `/tmp/workspace`, then delete the session.
4. Start a new session and read the file back. It survived the sandbox deletion.
5. Negative test: set a name that does not exist. The first tool call fails with a **"Filesystem attach failed"** toast, and no command runs against ephemeral storage.

### Hosted git repository

1. Add `{ "gitRepo": "test-repo" }` to the plugin options (or export `TENSORLAKE_GIT_REPO=test-repo`) and restart OpenCode.
2. Ask the model to clone the repo, commit a file, and push. The system prompt gives it the clone URL; the push uses the scoped credential the plugin stored in the sandbox.
3. Confirm the commit landed: `tl` or the Tensorlake console shows it, or clone the repo elsewhere.
4. Confirm isolation: `cat ~/.git-credentials` in the sandbox shows only the Tensorlake host line, never your own credentials.

### Suspend and resume across restart

1. Create a sandbox (run any command), then quit OpenCode (Ctrl+C). The log shows the sandboxes being suspended.
2. Start OpenCode, open the same session, and run a command. A **"Sandbox resumed"** toast appears and the files from before the restart are still there.

## Debugging

### Plugin not loading

Check the OpenCode server log:

```bash
ls -lt ~/.local/share/opencode/log/*.log | head -3
cat ~/.local/share/opencode/log/<latest>.log | grep -i "plugin\|error\|tensorlake"
```

- **"Plugin export is not a function"** — the path in `opencode.json` points to the repository root instead of the `.ts` entry file. Make sure it ends with `.opencode/plugin/index.ts`.
- **"404 failed to install plugin"** — for npm installs, verify the package name is `tensorlake-opencode`. For local installs, the `file://` prefix is likely missing, so OpenCode tries to fetch your local path from npm.

Note: OpenCode installs the npm package into its own cache (`~/.cache/opencode/packages/`), not your project or global `node_modules`. Listing it in `opencode.json` is enough; a manual `npm install` elsewhere has no effect.

### Sandbox not being used

If OpenCode loads but commands run locally, the plugin tools are not registered. Check the server log for a second round of tool registrations after the built-ins:

```
service=tool.registry status=started bash   ← built-in
...
service=tool.registry status=started bash   ← plugin override (should appear)
```

If the second block is absent, the plugin loaded but failed to return its hooks. Check `tensorlake.log` for startup errors.

### Sandbox not suspending on exit

Suspension requires the sandbox to have been **named** at creation time. Sandboxes created before this was implemented cannot be suspended. Delete the old session to trigger cleanup, then create a new session — new sandboxes are always named.

## Changing sandbox defaults

The resource env vars (`TENSORLAKE_CPUS`, `TENSORLAKE_MEMORY_MB`, `TENSORLAKE_DISK_MB`, `TENSORLAKE_IMAGE`) are documented in the README. The code defaults live in `TensorlakeClient.createSandbox` in `.opencode/plugin/tensorlake/core/client.ts`:

```typescript
const cpus = parseFloat(process.env.TENSORLAKE_CPUS ?? '2')
const memoryMb = parseInt(process.env.TENSORLAKE_MEMORY_MB ?? '4096', 10)
const ephemeralDiskMb = parseInt(process.env.TENSORLAKE_DISK_MB ?? '10240', 10)
```

To register a custom image:

```bash
tl sbx image create Dockerfile --registered-name my-custom-image
```

## Adding a new tool

1. Create a file in `.opencode/plugin/tensorlake/tools/` that follows the pattern of the existing tools.
2. Import and register it in `.opencode/plugin/tensorlake/tools.ts`.

Each tool factory receives `(sessionManager, projectId, worktree, pluginCtx)` and returns an object with `description`, `args` (a Zod schema map), and `execute(args, ctx)`.
