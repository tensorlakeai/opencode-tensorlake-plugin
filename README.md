# tensorlake-opencode

An OpenCode plugin that runs all AI sessions inside isolated [TensorLake](https://tensorlake.ai) sandboxes. Every bash command, file read/write, and search is executed in the sandbox rather than on your local machine.

---

## Overview

When the plugin is active, OpenCode intercepts the standard tool calls (bash, read, write, edit, ls, glob, grep) and routes them to a TensorLake sandbox:

- **Sandbox lifecycle** - A sandbox is created on the first tool call in a session and deleted when the session is deleted. Sandbox state is persisted to disk so that reconnection is possible across OpenCode restarts.
- **Suspension/resume** - If a sandbox is found in a suspended state it is automatically resumed before use.
- **System prompt injection** - A block is appended to the system prompt on every request informing the model that it is operating inside a sandbox at `/tmp/workspace`.
- **Toast notifications** - Sandbox status events (created, connected, resumed, deleted) surface as TUI toasts.
- **Logging** - All plugin activity is written to `~/.local/share/opencode/log/tensorlake.log`.

### Intercepted tools

| OpenCode tool | Sandbox implementation |
|---|---|
| `bash` | `sandbox.run('sh', { args: ['-c', cmd] })` via SDK |
| `read` | `sandbox.readFile(path)` via SDK |
| `write` | `sandbox.writeFile(path, content)` via SDK |
| `edit` | read + string replace + write |
| `ls` | `sandbox.listDirectory(path)` via SDK |
| `glob` | `find … -name "pattern"` via bash |
| `grep` | `grep -rn …` via bash |

---

## Prerequisites

- An OpenCode installation (see [opencode.ai](https://opencode.ai))
- A TensorLake account and API key (sign up at [tensorlake.ai](https://tensorlake.ai))

---

## Installation & Configuration

OpenCode can install plugins directly from npm. Use the npm package name in your OpenCode config unless you are developing the plugin locally.

### 1. Install from npm

Add the plugin package name to `~/.config/opencode/opencode.json` (create it if it doesn't exist):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "tensorlake-opencode"
  ]
}
```

OpenCode treats bare plugin names as npm packages, so it will install `tensorlake-opencode` from the npm registry.

You can list multiple plugins in the same array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "tensorlake-opencode",
    "opencode-helicone-session",
    "opencode-wakatime",
    "@my-org/custom-plugin"
  ]
}
```

### 2. Set your API key

```bash
export TENSORLAKE_API_KEY=your_api_key_here
```

### Local development install

OpenCode can also run plugins as TypeScript source files directly via its embedded Bun runtime. Use this option when you are modifying this repository locally.

Clone the repository:

```bash
git clone https://github.com/tensorlakeai/opencode-tensorlake-plugin ~/opencode-tensorlake-plugin
```

Then point OpenCode at the plugin entry file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///Users/your-username/opencode-tensorlake-plugin/.opencode/plugin/index.ts"
  ]
}
```

For local paths:
- The `file://` prefix is required. Without it, OpenCode treats the value as an npm package name.
- The path must point directly to the `.ts` entry file (`.opencode/plugin/index.ts`), not the repository root.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `TENSORLAKE_API_KEY` | (required) | Your TensorLake API key |
| `TENSORLAKE_ORGANIZATION_ID` | (required for PAT keys) | Organization ID (e.g. `org_…`). Required when using a Personal Access Token; not needed for project-scoped keys. |
| `TENSORLAKE_PROJECT_ID` | (required for PAT keys) | Project ID (e.g. `project_…`). Required when using a Personal Access Token; not needed for project-scoped keys. |
| `TENSORLAKE_API_URL` | `https://api.tensorlake.ai` | Override the management API base URL |
| `TENSORLAKE_IMAGE` | (server default) | Container image to use when creating a new sandbox. Leave unset to use the platform default. |
| `TENSORLAKE_CPUS` | `2` | Number of vCPUs allocated to the sandbox |
| `TENSORLAKE_MEMORY_MB` | `4096` | RAM allocated to the sandbox in MB |
| `TENSORLAKE_DISK_MB` | `10240` | Ephemeral disk size allocated to the sandbox in MB |
| `TENSORLAKE_SANDBOX_PROXY_URL` | (auto) | Override the sandbox proxy URL (useful for local development). When set, all sandboxes use this single URL instead of the `https://{id}.sandbox.tensorlake.ai` pattern |

---

## How to Test

### Basic smoke test

1. Set the environment variable and start OpenCode in a project directory:

   ```bash
   export TENSORLAKE_API_KEY=your_key
   opencode
   ```

2. After OpenCode loads you should see a toast notification: **"Sandbox created - New sandbox is ready."**

3. Confirm the sandbox appears in the log:

   ```bash
   tail -f ~/.local/share/opencode/log/tensorlake.log
   ```

   You should see lines like:

   ```
   [2024-01-15T10:00:01.000Z] [INFO] OpenCode started with TensorLake plugin
   [2024-01-15T10:00:01.200Z] [INFO] Creating new sandbox for session abc123
   [2024-01-15T10:00:03.500Z] [INFO] Sandbox created sandbox-xyz in 2300ms
   ```

### Bash command test

In the OpenCode chat prompt, type:

```
Run: echo "hello from sandbox" && uname -a
```

The model will call the `bash` tool. Because the plugin intercepts it, the command executes inside the TensorLake sandbox. You should see Linux kernel information from the sandbox VM rather than your local machine.

### File read/write test

```
Write the text "Hello TensorLake" to /tmp/workspace/test.txt, then read it back.
```

The model will:
1. Call `write` with `filePath=/tmp/workspace/test.txt` → routed to `sandbox.writeFile()` via SDK
2. Call `read` with `filePath=/tmp/workspace/test.txt` → routed to `sandbox.readFile()` via SDK

The response should echo back `Hello TensorLake`.

### Directory listing test

```
List the files in /tmp/workspace
```

This triggers the `ls` tool, which calls `sandbox.listDirectory('/tmp/workspace')` via the SDK.

### Verifying sandbox deletion

Delete the OpenCode session from the session list. The plugin handles the `session.deleted` event and calls `sdk.delete(sandboxId)` via the TensorLake SDK. Confirm in the log:

```
[…] [INFO] Deleting sandbox sandbox-xyz for session abc123
[…] [INFO] Sandbox sandbox-xyz deleted
```

---

## Troubleshooting

### Plugin not loading

Check the OpenCode server log for errors:

```bash
ls -lt ~/.local/share/opencode/log/*.log | head -3
cat ~/.local/share/opencode/log/<latest>.log | grep -i "plugin\|error\|tensorlake"
```

**"Plugin export is not a function"** — The path in `opencode.json` points to the repository root instead of the `.ts` entry file. Make sure the path ends with `.opencode/plugin/index.ts`.

**"404 failed to install plugin"** — For npm installs, verify the package name is `tensorlake-opencode`. For local development installs, this usually means the `file://` prefix is missing and OpenCode is trying to fetch your local path as an npm package name. Add `file://` before the absolute path.

### Sandbox not being used

If OpenCode loads but commands run locally (not in the sandbox), the plugin tools are not being registered. Verify by checking the server log for a second round of tool registrations after the built-ins:

```
service=tool.registry status=started bash   ← built-in
...
service=tool.registry status=started bash   ← plugin override (should appear)
```

If the second block is absent, the plugin loaded but failed to return its hooks. Check `tensorlake.log` for errors logged during startup.

### Sandbox not suspending on exit

Suspension requires the sandbox to have been **named** at creation time. Sandboxes created before this was implemented (ephemeral) cannot be suspended. Delete the old session from OpenCode's session list to trigger cleanup, then create a new session — new sandboxes are always named.

---

## Development

### Project structure

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
            │   ├── client.ts                 # TensorLake SDK client (SandboxClient wrapper)
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
                ├── custom-tools.ts           # wires tools into plugin return value
                ├── session-events.ts         # handles session.deleted event
                └── system-transform.ts       # injects sandbox context into system prompt
```

### Type checking

```bash
npm run type-check
```

### Building

```bash
npm run build
```

Output is emitted to `dist/` with declaration files. The `tsconfig.lib.json` sets `rootDir` to `.opencode/plugin` so the output mirrors that structure under `dist/`. The `main` field in `package.json` points to `dist/index.js`.

### Modifying sandbox resources

To change the default CPU/memory/disk allocation, set environment variables before starting OpenCode:

```bash
export TENSORLAKE_CPUS=4
export TENSORLAKE_MEMORY_MB=8192
export TENSORLAKE_DISK_MB=20480
```

Or edit the defaults directly in `TensorLakeClient.createSandbox` inside `.opencode/plugin/tensorlake/core/client.ts`:

```typescript
const cpus = parseFloat(process.env.TENSORLAKE_CPUS ?? '2')
const memoryMb = parseInt(process.env.TENSORLAKE_MEMORY_MB ?? '4096', 10)
const ephemeralDiskMb = parseInt(process.env.TENSORLAKE_DISK_MB ?? '10240', 10)
```

### Changing the default sandbox image

Set `TENSORLAKE_IMAGE` to a registered image name before starting OpenCode:

```bash
export TENSORLAKE_IMAGE=my-custom-image
```

When unset, the platform's default image is used. To register a custom image:

```bash
tl sbx image create Dockerfile --registered-name my-custom-image
```

### Adding new tools

1. Create a new file in `.opencode/plugin/tensorlake/tools/mytool.ts` following the same pattern as the existing tools.
2. Import and register it in `.opencode/plugin/tensorlake/tools.ts`.

Each tool factory receives `(sessionManager, projectId, worktree, pluginCtx)` and returns an object with `description`, `args` (a Zod schema map), and `execute(args, ctx)`.
