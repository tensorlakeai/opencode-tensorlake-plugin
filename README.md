# tensorlake-opencode

An OpenCode plugin that runs all AI sessions inside isolated [Tensorlake](https://tensorlake.ai) sandboxes. Every bash command, file read/write, and search executes in the sandbox, not on your local machine.

## How it works

The plugin intercepts OpenCode's standard tools (`bash`, `read`, `write`, `edit`, `ls`, `glob`, `grep`) and routes them to a Tensorlake sandbox at `/tmp/workspace`.

- **Lazy creation** — no sandbox starts when you launch OpenCode. The sandbox is created on the model's first tool call in a session. To start one, ask the model to run a command.
- **Lifecycle** — the sandbox is deleted when you delete the session. Sandbox state persists to disk, so sessions reconnect across OpenCode restarts. A suspended sandbox resumes automatically before use.
- **Project sync** — the project you opened in OpenCode is synced into the sandbox at `/tmp/workspace/<project-name>` on first use. See [Project sync](#project-sync).
- **Background processes** — `bash` with `background=true` starts a long-running process in the sandbox (dev server, watcher) and returns its pid. Two extra tools, `bash_output` and `bash_kill`, let the model read new output and stop the process.
- **Visibility** — sandbox events (created, connected, resumed, deleted) appear as TUI toasts, and all plugin activity is logged to `~/.local/share/opencode/log/tensorlake.log`.

## Project sync

The first time a sandbox is used (per OpenCode process), the plugin syncs your local project into it so the sandbox is not empty. The mode is chosen automatically:

| Local project | Sync mode | How it works |
|---|---|---|
| Git repository (has `.git`) | `git` | Your repo's **real commit history** is pushed to the **sync repo** — a [Tensorlake git repository](https://docs.tensorlake.ai/git/introduction) the plugin creates for your project, named `opencode-<project-id>` — **under your current branch name**, and the sync repo is cloned inside the sandbox on that same branch — so `git log`, `git blame`, and `git diff` in the sandbox show your actual commits, authors, and dates. Uncommitted local changes (modified + untracked files) are replayed onto the sandbox working tree, uncommitted, so the sandbox matches your laptop exactly. Git credentials and a fallback identity are configured in the sandbox so the model can commit and `git push` to persist changes back to the sync repo; **pushed commits are pulled back into your local branch automatically** (see below). A repo with no commits yet is synced as a single snapshot commit instead. |
| Folder that is already a `tl fs` mount | `mount` | The sandbox mounts **the same filesystem** your folder serves, so nothing is copied in either direction. The mount daemon's autosave carries writes both ways: what the agent writes appears in your local folder in about a second, and what you edit locally is what the agent sees. Detected by asking `tl fs status --json` about the folder — the plugin never creates or converts a mount itself, because `tl fs mount` requires an empty mountpoint. Set one up with `tl fs create <name> && tl fs mount <name> <empty dir>`, then open that directory in OpenCode. Same-path writes are last-writer-wins, so avoid editing the same file as the agent at the same moment. |
| Plain folder | `volume` | The folder is uploaded to a Tensorlake cloud volume (`opencode-folder-<hash of the folder path>` — OpenCode reports no project for a non-repository folder, so the plugin identifies it by its path) and the volume is mounted into the sandbox. Writes inside the mount are persisted to durable storage automatically and survive sandbox termination. Common build artifacts (`node_modules`, `.venv`, `dist`, `target`, …) and files over 100 MB are skipped. **Files the agent changes are downloaded back into your local folder after each agent turn** (see [Volume-mode sync-back](#volume-mode-sync-back)). |

The project lands at `/tmp/workspace/<project-name>`, which is also the default working directory for `bash`, `ls`, `glob`, and `grep`.

Override the automatic choice with `TENSORLAKE_SYNC_MODE`:

```bash
export TENSORLAKE_SYNC_MODE=git     # always use git push/clone
export TENSORLAKE_SYNC_MODE=mount   # require the folder to be a tl fs mount and attach it
export TENSORLAKE_SYNC_MODE=volume  # always upload to a cloud volume
export TENSORLAKE_SYNC_MODE=off     # disable project sync (pre-0.3.0 behavior)
```

Sync failures are surfaced as a toast and logged, but never block the sandbox — you just get an empty workspace.

> A sandbox clone that has its own commits or edits is never reset — re-sync only fast-forwards, and uncommitted local changes are only replayed onto a clean sandbox tree.

### Post-sync setup command

Sync carries no dependency directories (`node_modules`, `.venv`, …), so a fresh sandbox has none. Instead of letting the agent discover this and burn turns on `npm install`, configure a setup command that runs automatically after the first sync — like a devcontainer `postCreateCommand`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["tensorlake-opencode", { "setup": "npm ci" }]
  ]
}
```

Put it in the project's own `opencode.json` so the whole team gets it, or in the global `~/.config/opencode/opencode.json`. The `TENSORLAKE_SETUP_COMMAND` environment variable overrides both.

The command runs in the sandbox project directory, before the first tool call proceeds, with a 15-minute timeout. It runs **once per sandbox lifetime**: sandboxes are stateful and survive OpenCode restarts, so a marker file inside the sandbox — not plugin memory — records that setup ran. Changing the command runs the new one once. A failed command shows an error toast with the last output lines and is not retried; fix it, or ask the agent to run it.

### Re-sync: local changes made mid-session

You do not need to restart OpenCode to get local changes into the sandbox:

- **Automatic (git mode).** On tool calls the plugin checks (at most every 15 s) whether your local state changed since the last sync — new commits, edits, or a branch switch. If it did, the sync re-runs in the background: your state is pushed to the sync repo, the sandbox clone fast-forwards, and uncommitted changes are replayed onto a clean sandbox tree.
- **On demand (`sync` tool).** The model has a `sync` tool that forces a full sync right now, both ways in git and volume mode. Just say "sync my local changes" (or the model calls it itself when you mention edits it cannot see). In volume mode it first downloads files the agent changed, then re-uploads your local files, replacing the volume's copies of them; in mount mode it is a no-op (the filesystem is already shared).

### Where agent commits go (git mode)

**Agent commits do not go to GitHub directly.** Inside the sandbox, `origin` points to the sync repo — not to your GitHub/GitLab remote. The plugin never copies your GitHub credentials or remotes into the sandbox. When the agent commits and runs `git push`, the work lands on the sync repo, on the same branch you have checked out locally.

**The plugin pulls agent commits back to your machine automatically.** After each agent turn, it fetches the sync repo into `refs/remotes/tensorlake/*` and fast-forwards your local branch when that is safe (your worktree is clean and the histories have not diverged). You see a toast when commits land. So the everyday flow is:

```bash
# you are on feature-x; the agent works in the sandbox on feature-x
# agent commits and pushes -> your local feature-x advances automatically

# review, then send it to GitHub from your machine as usual:
git push origin feature-x
gh pr create
```

When a fast-forward is not safe, nothing in your checkout is touched. The commits wait on the `tensorlake/<branch>` tracking ref, a toast tells you why (uncommitted local changes, or diverged histories), and you merge on your own terms:

```bash
git stash              # if the blocker was uncommitted changes
git merge tensorlake/feature-x
git stash pop
```

**Uncommitted sandbox work comes back too — but is never applied.** After each agent turn, if the sandbox working tree has uncommitted changes (edits the agent did not commit), the plugin captures them as a WIP commit on the sync repo and stages that commit on a local scratch ref, `tensorlake-wip/<branch>`. Your working tree and branches are never touched. A toast tells you when new WIP is staged:

```bash
git diff tensorlake-wip/feature-x~ tensorlake-wip/feature-x   # look at it
git cherry-pick -n tensorlake-wip/feature-x                   # take it, uncommitted
```

When the agent commits (or discards) that work, the WIP ref is cleared automatically on the next turn. The capture uses a temporary index, so it never disturbs the agent's index or working tree either.

The sync repo is a normal Tensorlake git repository, so the standard `tl git` commands (`tl git list`, `tl git token`, …) work with it if you ever want to inspect it directly.

To push agent work to GitHub, let the sync-back land it (or merge the tracking ref), then push from your machine. Alternatively, add your GitHub remote and credentials inside the sandbox yourself — the plugin does not do this for you.

### Volume-mode sync-back

For a plain (non-git) folder, agent output no longer stays stranded on the cloud volume. After each agent turn, the plugin asks the volume for its current version — one cheap call — and if anything changed, downloads the changed files into your local folder. A toast reports how many files landed. Change detection is server-side: every file and directory on a volume has a stable content id, so unchanged subtrees are skipped without listing them.

Your own edits are protected:

- A local file is overwritten **only** when it is unchanged since the last sync (its content still matches what was uploaded or downloaded last time).
- A file changed both locally and in the sandbox is left untouched locally and reported as a conflict. Run a sync (say "sync my local changes") to make your local version win — the volume keeps every prior version if you need the agent's copy.
- A file the agent deleted on the volume is **never** deleted locally.

Skipped-directory content (`node_modules`, `dist`, …) and files over 100 MB are not downloaded.

### Why a sync repo instead of cloning your remote in the sandbox?

The agent could simply `git clone` your GitHub repo inside the sandbox. The sync repo exists because that has three problems the plugin is designed to avoid:

- **No GitHub credentials in the sandbox.** The sandbox runs agent-generated code. A GitHub token inside it can leak. The sandbox only receives a Tensorlake credential scoped to the one sync repo — your GitHub account is unreachable by construction.
- **The sandbox matches your laptop, not your remote.** A clone of GitHub misses unpushed commits, uncommitted edits, and untracked files. The sync includes all of them, and works for repos with no remote at all.
- **A review gate.** Agent pushes land on the sync repo and sync back to your local branch. Only you push to GitHub, after review — the agent never can.

> **Branch naming.** The sync branch is whatever `git branch --show-current` reports on your machine when the sync runs — one name everywhere: local, sync repo, and sandbox. A detached HEAD (or a branch name that cannot be embedded safely) syncs as `main`. If you switch local branches, the next sandbox sync follows: a clean sandbox clone switches to the new branch; one with its own edits is left untouched.

> If you rewrite local history (rebase, amend), the next sync recreates the sync repo from your rewritten history — any commits that existed only on the sync repo are discarded. The automatic sync-back makes this window small (agent commits normally reach your machine within a turn), but rebasing mid-turn while the agent still has unpushed or unfetched work can lose it. An existing sandbox clone can't fast-forward to rewritten history; delete the session's sandbox to get a fresh clone.

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

## Configuration

All settings are optional environment variables:

| Variable | Default | Description |
|---|---|---|
| `TENSORLAKE_API_KEY` | — | Overrides the key stored by `opencode auth login`. For CI/automation. |
| `TENSORLAKE_IMAGE` | server default | Container image for new sandboxes. |
| `TENSORLAKE_CPUS` | `2` | vCPUs per sandbox. |
| `TENSORLAKE_MEMORY_MB` | `4096` | RAM in MB. |
| `TENSORLAKE_DISK_MB` | `10240` | Ephemeral disk in MB. |
| `TENSORLAKE_API_URL` | `https://api.tensorlake.ai` | Management API base URL. |
| `TENSORLAKE_SANDBOX_PROXY_URL` | auto | Sandbox proxy URL override, for local development. |
| `TENSORLAKE_SYNC_MODE` | `auto` | Project sync mode: `auto`, `git`, `mount`, `volume`, or `off`. See [Project sync](#project-sync). |
| `TENSORLAKE_SETUP_COMMAND` | — | Command to run once after the first project sync (e.g. `npm ci`). Overrides the `setup` plugin option. See [Post-sync setup command](#post-sync-setup-command). |

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
