# software-factory (`sf`)

A local factory that takes tickets through spec, build, checks, review and a human approval, using Claude Code workers inside Docker Sandboxes.
State lives in SQLite under `~/.sf` (override with `SF_HOME`). You approve in a localhost dashboard.

## Requirements

- Node 24+
- git 2.38+ (needs `merge-tree --write-tree`)
- Docker Sandboxes (`sbx`)
- Claude Code, only for the /sf skill session (sf itself runs claude inside the sandbox, never on the host)
- uv
- graphify (optional, enables graph updates)

## One-time setup

```sh
npm install
npm run build:web
npm link            # puts `sf` on PATH
sf doctor           # checks tools, template, secret, orphans
```

Create the sandbox template with Node 24 (the default image has none). Start a spike sandbox, install Node 24 as root, then save it:

```sh
sbx --no-input create claude <scratch-dir> --name sf-spike
sbx exec -u root sf-spike bash -c "curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs"
sbx --no-input template save sf-spike sf-claude-node24
sbx rm --force sf-spike
```

Register the Context7 docs MCP (host-global):

```sh
sbx mcp add context7 --url https://mcp.context7.com/mcp
```

Auth: the workers use your Claude subscription through the sbx secret store (`sbx secret ls` shows an `anthropic` secret with oauth configured). No API key goes into the sandbox. If `sf doctor` warns about it, log in through `sbx` again.

## Flow

```sh
sf repo add <path>                       # prints the detected profile; confirm or fix with `sf repo profile`
sf ticket add <repoId> --title "..." --body "..."
sf serve                                 # in its own terminal; prints http://127.0.0.1:4400
sf spec T-1 --agent                      # or --file spec.md; the agent spec runs under sf serve
sf ticket show T-1                       # wait for `specified`, read the spec (replace it with --file if needed)
sf ready T-1
sf approve T-1                           # or approve/reject in the dashboard
```

Other commands: `repo list`, `ticket list|show`, `reject`, `answer`, `retry`, `reset`, `cancel`, `doctor --fix`.
Stop `sf serve` before `sf doctor --fix`, or it may remove the worktree and sandbox of a running ticket.
Claude Code users can drive all of this through `/sf` from inside any repo: it registers the repo, starts `sf serve` if needed and runs the ticket flow from the conversation. Install it by linking the skill folder (a junction keeps it in sync with this repo):

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\sf" -Target "$PWD\skill"   # Windows
```
```sh
ln -s "$PWD/skill" ~/.claude/skills/sf   # macOS / Linux
```

## Safety model

- Git never runs in the sandbox; the host does all git work, and the sandbox only sees the worktree.
- Worker code never runs on the host; repo setup and checks run in sandboxes.
- Commits use disabled hooks (`core.hooksPath` empty, `--no-verify`), so repo hooks cannot execute on the host.
- The API binds to 127.0.0.1 only and checks both the Origin and Host headers.
- Only the approved head is squashed onto the target branch, and only if it still matches what you approved.

## Limits and deferred

- One worker at a time.
- No pull requests and no push; the result is a local squash commit on the target branch.
- Merge conflicts block the ticket for you to `retry` or `reset`; there is no automatic resolution.
- Checks run in a sandbox with no secrets and npm/PyPI-only egress, so tests needing other network access or credentials fail.
