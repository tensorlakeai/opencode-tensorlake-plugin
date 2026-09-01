# tensorlake-opencode

An OpenCode plugin that runs all AI sessions inside isolated [Tensorlake](https://tensorlake.ai) sandboxes. Every bash command, file read/write, and search executes in the sandbox, not on your local machine.

## How it works

The plugin intercepts OpenCode's standard tools (`bash`, `read`, `write`, `edit`, `multiedit`, `apply_patch`, `ls`, `glob`, `grep`) and routes them to a Tensorlake sandbox at `/tmp/workspace`.

- **Lazy creation** — no sandbox starts when you launch OpenCode. The sandbox is created on the model's first tool call in a session. To start one, ask the model to run a command.
- **Lifecycle** — each session's sandbox is named after the session (`opencode-<session id>`), and every tool call binds to it with `Sandbox.getOrCreate`. Nothing is stored locally: a session reconnects to its sandbox across OpenCode restarts, and from another machine. A suspended sandbox resumes automatically before use. The sandbox is deleted when you delete the session.
- **Subagents share the sandbox** — a subagent (the `task` tool) runs in its own OpenCode session but uses the sandbox of the session that spawned it, so a task and the agent that spawned it see the same files. See [Subagents](#subagents).
- **Persistent filesystem (optional)** — configure a Tensorlake filesystem and every sandbox mounts it at the working directory. Files there survive sandbox deletion. See [Persistent filesystem](#persistent-filesystem).
- **Hosted git repository (optional)** — configure a Tensorlake-hosted git repository and every sandbox gets scoped git credentials for it, so the agent can clone, commit, and push to persist work. See [Hosted git repository](#hosted-git-repository).
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

**CI / automation:** set `TENSORLAKE_API_KEY` instead. The environment variable wins over the stored key. Use a project API key — the key itself selects the organization and project. Personal Access Tokens are not supported.

## Subagents

A subagent session shares the sandbox of the session that spawned it, all the way up to the root session of the tree. This mirrors how local subagents share the user's working tree: the parent sees the subagent's edits, and the subagent sees the parent's.

- **Deleting a subagent session deletes nothing.** The sandbox belongs to the root session, and is torn down when *that* session is deleted.
- **Deleting the root session waits for subagent tool calls** that are still running, so nothing is terminated mid-write.

## Persistent filesystem

By default a sandbox's disk is ephemeral: deleting the session deletes its files. To keep files across sandboxes and sessions, attach a [Tensorlake filesystem](https://docs.tensorlake.ai):

```bash
tl fs create my-workspace
```

Then name it in the plugin options or the environment:

```json
{
  "plugin": [
    ["tensorlake-opencode", { "filesystem": "my-workspace" }]
  ]
}
```

Every sandbox now mounts that filesystem at the working directory (`/tmp/workspace`) — new sandboxes through `Sandbox.getOrCreate`'s `fileSystems` option, reconnected ones through a live attach. Files the agent writes there persist in durable storage, survive sandbox deletion, and are shared with every other sandbox (or `tl fs mount` on your machine) that mounts the same filesystem. Set `filesystemPath` (or `TENSORLAKE_FILESYSTEM_PATH`) to mount it somewhere else.

A misspelled filesystem name blocks tool calls with a clear error instead of running against ephemeral storage.

### Work with the filesystem from your machine

Two commands put local files into a Tensorlake filesystem. They behave very differently, and the difference can destroy the agent's work.

`tl fs mount <name> <empty-dir>` is two-way and continuous. A write in the sandbox reaches your directory in about a second, and a write on your machine reaches the sandbox just as fast. Use this while a session is running.

`tl fs push <dir> <name>` is one-way and destructive. It makes the filesystem match your local directory exactly, so a second push **deletes every file the agent created** and reverts every file the agent edited. Use it once to seed a filesystem, never while a session is running.

Three details that matter:

- **The mountpoint must be empty.** You cannot mount over an existing project directory. Create an empty directory, mount it, then move your project inside.
- **Names arrive before bytes.** A new file can appear in a listing seconds before its content is readable. Do not treat `ls` on one side as proof that the other side finished writing.
- **Concurrent writes to one file lose data silently.** The later write wins, with no conflict marker and no error. Give the agent its own subtree if you edit at the same time.

For a git repository, use `tl git mount` instead. It autosaves into a private workspace and turns snapshots into real commits.

## Hosted git repository

To let the agent persist work through git, configure a [Tensorlake git repository](https://docs.tensorlake.ai/git/introduction). The repository is hosted in your Tensorlake project, not on GitHub or any public service. Only people with an API key for the project can see it or push to it.

```json
{
  "plugin": [
    ["tensorlake-opencode", { "gitRepo": "my-repo" }]
  ]
}
```

The plugin creates the repository if it does not exist, and sets up each sandbox so the agent can use it: a Tensorlake credential scoped to that one repository, and a fallback git identity. Credentials are refreshed automatically in long sessions. The model is told the clone URL, so "clone the repo, make the change, push" works out of the box.

Your own git credentials and remotes never enter the sandbox — only the scoped Tensorlake credential does. To publish the code elsewhere, clone the Tensorlake repository to your machine and push it to GitHub yourself.

You can use `filesystem` and `gitRepo` together. The agent then clones the repository onto the mounted filesystem, so the working copy survives sandbox deletion and the pushed commits live in the repository. If you also mount that filesystem on your machine, run git commands from one side only: concurrent writes to the same `.git` files lose data silently.

## Configuration

Plugin options (in `opencode.json`, env vars win):

| Option | Env var | Description |
|---|---|---|
| `filesystem` | `TENSORLAKE_FILESYSTEM` | Tensorlake filesystem to mount into every sandbox. See [Persistent filesystem](#persistent-filesystem). |
| `filesystemPath` | `TENSORLAKE_FILESYSTEM_PATH` | Mount path for that filesystem. Default: `/tmp/workspace`. |
| `gitRepo` | `TENSORLAKE_GIT_REPO` | Tensorlake-hosted git repository to set up in every sandbox. See [Hosted git repository](#hosted-git-repository). |

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `TENSORLAKE_API_KEY` | — | Overrides the key stored by `opencode auth login`. For CI/automation. |
| `TENSORLAKE_IMAGE` | server default | Container image for new sandboxes. |
| `TENSORLAKE_CPUS` | `2` | vCPUs per sandbox. |
| `TENSORLAKE_MEMORY_MB` | `4096` | RAM in MB. |
| `TENSORLAKE_DISK_MB` | `10240` | Ephemeral disk in MB. |
| `TENSORLAKE_API_URL` | `https://api.tensorlake.ai` | Management API base URL. |
| `TENSORLAKE_SANDBOX_PROXY_URL` | auto | Sandbox proxy URL override, for local development. |
| `TENSORLAKE_SHUTDOWN_DRAIN_MS` | `15000` | How long exit waits for in-flight sandbox work before suspending. |

## Troubleshooting

**No sandbox starts when I launch OpenCode.** This is expected — the sandbox is created on the first tool call, not at launch. Ask the model to run a command (for example, `Run: uname -a`).

**"Tensorlake login required" toast.** Run `opencode auth login`, select Tensorlake, and paste a project API key. No restart is needed — retry the tool call.

**Auth error (401/403) in the log.** The stored key was revoked. Re-run `opencode auth login` with a fresh project API key.

**"Filesystem attach failed" toast.** The name in `filesystem` / `TENSORLAKE_FILESYSTEM` does not exist in this project. Create it with `tl fs create <name>` or fix the name.

**`tl fs unmount` fails with `volume_busy`.** A process still holds the mount, usually a shell whose working directory is inside it. Leave the directory (`cd ~`), close editors pointed at the path, then unmount. Find the holder with `lsof -w | awk '$NF ~ /^\/path\/to\/mount/'` and read the `cwd` rows.

**`Missing native binding for <platform>`.** Your platform is not supported by the Tensorlake SDK — see [Requirements](#requirements).

**Anything else.** Check `~/.local/share/opencode/log/tensorlake.log`. If the file does not exist, the plugin never loaded — see [DEVELOPMENT.md](DEVELOPMENT.md#debugging).

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for local setup, project structure, manual tests, and debugging.

## License

Apache-2.0
