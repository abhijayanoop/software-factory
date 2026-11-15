# Sandbox spike notes (Task 0) — 2026-11-15

Environment: `sbx` v0.51.0 and Claude Code 2.1.325 on the host. The default `claude` kit image is
"Docker Hardened Images (Debian 13 trixie)".

## Results

| Check | Result |
|---|---|
| Unattended auth on the Claude subscription | **Works.** `sbx secret ls` shows a global `anthropic` service secret, `(oauth configured)`. A fresh sandbox ran `claude -p` with no login prompt. No setup-token or fallback needed. |
| Prompt delivery | **stdin works:** `<prompt> \| sbx exec -i <name> claude -p --output-format stream-json --verbose --dangerously-skip-permissions` |
| Edits visible on host | **Yes.** The worktree is mounted rw at the same path, translated to POSIX (`C:\Users\…` → `/c/Users/…`). The agent's cwd is the workspace. |
| User in sandbox | `agent`; `sudo -n` available |
| Toolchain in default image | `python3` 3.14.10, `uv` 0.13.8, `git` 2.47.3, `claude` 2.1.325. **No `node`/`npm`.** |
| Egress | Deny by default (`default-deny-all` + `local-policy` allowlist). `example.com` → 403. `registry.npmjs.org`, `pypi.org`, `deb.nodesource.com` → allowed. `api.anthropic.com` works. No extra policy work needed. |
| Superpowers plugins in sandbox | **No.** `~/.claude/plugins` holds only `store`/`synced`. → Inline the needed TDD/verification rules into `src/prompts/build.md` (plan Task 7 fallback). |
| Context7 MCP | Not registered (`sbx mcp ls` empty). Needs `sbx mcp add context7`, a host-global sbx change. **Pending user OK.** |
| git inside sandbox | Present (2.47.3). The worktree `.git` file points to a `C:\…` path, so git can't resolve the repo in the sandbox. The host-only-git design holds. |

## stream-json shape (from `src/fixtures/stream-done.jsonl`)

- The last line is `{"type":"result", "subtype":"success", "is_error":false, "result":"<final text>", "total_cost_usd":…, "terminal_reason":"completed", "api_error_status":null, …}`.
- The final-line JSON contract is the last line of `result`. Example: `…\n\n{"status":"done","summary":"created hello.txt"}`.
- Cost: `total_cost_usd` (informational under the subscription).
- Rate limit: not captured live. Detect via `is_error:true` with `api_error_status` 429, or result text matching
  `/usage limit|rate limit/i`. Parse a reset time if the text has one. `src/fixtures/stream-rate-limited.jsonl` is hand-written
  from this shape (see the fixture's comment-free JSON).

## Resolved (user-approved)

- **Node:** Node 24.22.3 was installed as root via NodeSource in a spike sandbox. Saved with
  `sbx --no-input template save sf-spike sf-claude-node24` as `docker.io/library/sf-claude-node24:latest`.
  It contains node 24, npm 11, uv 0.13.8, python 3.14 and claude.
- **Context7:** `sbx mcp add context7 --url https://mcp.context7.com/mcp` is registered host-globally.
  Verified in a fresh sandbox: the agent resolved `/reactjs/react.dev`.

## Exact commands for `SbxSandbox` (Task 6)

- **Create:**
  `sbx --no-input create claude <worktreePath> [<extra>:ro …] --name <name> -t sf-claude-node24 --pull never --static-mcp context7`
- **Exec agent:**
  `sbx exec -i <name> claude -p --output-format stream-json --verbose --dangerously-skip-permissions [--append-system-prompt <text>]`
  with the prompt on stdin.
- **Exec checks:** `sbx exec <name> <argv…>`. The cwd is the workspace path, translated to POSIX.
- **Remove:** `sbx rm --force <name>`. Plain `rm` prompts and fails without a tty.
- Always pass `--no-input` on create and template commands; otherwise they prompt and fail without a tty.
- No per-sandbox egress or auth commands are needed. Both come from global sbx config.
