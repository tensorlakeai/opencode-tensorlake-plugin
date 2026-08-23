# tensorlake-opencode

An OpenCode plugin that runs all AI sessions inside isolated [Tensorlake](https://tensorlake.ai) sandboxes. Every bash command, file read/write, and search executes in the sandbox, not on your local machine.

## How it works

The plugin intercepts OpenCode's standard tools (`bash`, `read`, `write`, `edit`, `ls`, `glob`, `grep`) and routes them to a Tensorlake sandbox at `/tmp/workspace`.

- **Lazy creation** — no sandbox starts when you launch OpenCode. The sandbox is created on the model's first tool call in a session. To start one, ask the model to run a command.
- **Lifecycle** — the sandbox is deleted when you delete the session. Sandbox state persists to disk, so sessions reconnect across OpenCode restarts. A suspended sandbox resumes automatically before use.
- **Visibility** — sandbox events (created, connected, resumed, deleted) appear as TUI toasts, and all plugin activity is logged to `~/.local/share/opencode/log/tensorlake.log`.

## Requirements

- An OpenCode installation ([opencode.ai](https://opencode.ai))
- A Tensorlake **project API key** — sign up at [tensorlake.ai](https://tensorlake.ai), then create a key at [cloud.tensorlake.ai](https://cloud.tensorlake.ai) under your project → **API Keys**

Supported platforms (the Tensorlake SDK ships a native binary):

- macOS: Apple Silicon only (Intel Macs are not supported)
- Linux: x64 and arm64 (glibc and musl)
- Windows: x64

## Install

Add the plugin to `~/.config/opencode/opencode.json` (create the file if it does not exist):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "tensorlake-opencode"
  ]
}
```

OpenCode installs the package from npm automatically.

## Log in

```bash
opencode auth login
```

Select **Tensorlake** and paste a project API key (starts with `tl_apiKey_`). The key is stored in OpenCode's credential store next to your other provider credentials. If the key is wrong, the first tool call shows an error toast that tells you to log in again.

**CI / automation:** set `TENSORLAKE_API_KEY` instead. The environment variable wins over the stored key. Personal Access Tokens work only through this path and also require `TENSORLAKE_ORGANIZATION_ID` and `TENSORLAKE_PROJECT_ID`; prefer project API keys.

## Configuration

All settings are optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `TENSORLAKE_API_KEY` | — | Overrides the key stored by `opencode auth login`. For CI/automation. |
| `TENSORLAKE_ORGANIZATION_ID` | — | Required only for Personal Access Tokens. A project key carries its own scope. |
| `TENSORLAKE_PROJECT_ID` | — | Required only for Personal Access Tokens. |
| `TENSORLAKE_IMAGE` | server default | Container image for new sandboxes. |
| `TENSORLAKE_CPUS` | `2` | vCPUs per sandbox. |
| `TENSORLAKE_MEMORY_MB` | `4096` | RAM in MB. |
| `TENSORLAKE_DISK_MB` | `10240` | Ephemeral disk in MB. |
| `TENSORLAKE_API_URL` | `https://api.tensorlake.ai` | Management API base URL. |
| `TENSORLAKE_SANDBOX_PROXY_URL` | auto | Sandbox proxy URL override, for local development. |

## Troubleshooting

**No sandbox starts when I launch OpenCode.** This is expected — the sandbox is created on the first tool call, not at launch. Ask the model to run a command (for example, `Run: uname -a`).

**"Tensorlake login required" toast.** Run `opencode auth login`, select Tensorlake, and paste a project API key. No restart is needed — retry the tool call.

**Auth error (401/403) in the log.** The stored key was revoked. Re-run `opencode auth login` with a fresh project API key.

**`Missing native binding for <platform>`.** Your platform is not supported by the Tensorlake SDK — see [Requirements](#requirements).

**Anything else.** Check `~/.local/share/opencode/log/tensorlake.log`. If the file does not exist, the plugin never loaded — see [DEVELOPMENT.md](DEVELOPMENT.md#debugging).

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for local setup, project structure, manual tests, and debugging.

## License

Apache-2.0
