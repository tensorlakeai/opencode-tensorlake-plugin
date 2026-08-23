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
            │   ├── logger.ts                 # file-based logger with rotation
            │   ├── session-manager.ts        # sandbox lifecycle management
            │   ├── toast.ts                  # TUI toast queue
            │   └── types.ts                  # shared type definitions
            ├── tools/
            │   ├── bash.ts
            │   ├── read.ts
            │   ├── write.ts
            │   ├── edit.ts
            │   ├── ls.ts
            │   ├── glob.ts
            │   └── grep.ts
            └── plugins/
                ├── auth.ts                   # registers Tensorlake in opencode auth login
                ├── custom-tools.ts           # wires tools into plugin return value
                ├── session-events.ts         # handles session.deleted event
                └── system-transform.ts       # injects sandbox context into system prompt
```

## Build and type-check

```bash
npm run type-check
npm run build
```

The build emits to `dist/` with declaration files. `tsconfig.lib.json` sets `rootDir` to `.opencode/plugin`, so the output mirrors that structure. The `main` field in `package.json` points to `dist/index.js`.

## Manual tests

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
   [...] [INFO] OpenCode started with TensorLake plugin
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

The resource env vars (`TENSORLAKE_CPUS`, `TENSORLAKE_MEMORY_MB`, `TENSORLAKE_DISK_MB`, `TENSORLAKE_IMAGE`) are documented in the README. The code defaults live in `TensorLakeClient.createSandbox` in `.opencode/plugin/tensorlake/core/client.ts`:

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
