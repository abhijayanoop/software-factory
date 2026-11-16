---
name: sf
description: Use when the user types /sf or asks to hand work to sf (the local software factory) from the repo they are in - turn a request into an sf ticket, get it specced and built, check sf ticket status, or approve, reject or answer an sf ticket. Not the `factory` CLI.
---

# sf: local software factory

`sf` is on PATH (`npm link` in the software-factory repo). If it is missing, tell the user to run `npm link` there and stop.

## 1. Set up (every time the skill starts)

1. **Repo.** Run `git rev-parse --show-toplevel` and `sf repo list` (lines are `id<TAB>path<TAB>branch`). If a listed path is the same directory as the toplevel (compare ignoring case, slash direction and `C:\` vs `/c/`), use that id. Otherwise run `sf repo add <toplevel>`, show the user the printed profile (setup and check commands) and ask if it is right. If they correct it, write the corrected JSON to a temp file and run `sf repo profile <id> --file <file>`. Not a git repo: tell the user and stop.
2. **Server.** Run `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4400/api/tickets`. `200` means `sf serve` is up. Otherwise start `sf serve` in the background (`run_in_background`) and read its first line, `sf serve: http://127.0.0.1:<port>`. If it fails with `sf serve already running`, it is on another port: ask the user for it. Give the user the dashboard URL.

## 2. Ticket flow

1. **Ticket.** From what the user asked for in the conversation, write a title and a body (goal, constraints, what done looks like; quote the user's words where they are precise). Show both and ask before creating. Then `sf ticket add <repoId> --title "..." --body-file <file>` (use a file for anything multi-line). It prints the ticket id.
2. **Spec.** Ask whether the factory should write the spec or whether they want one from you.
   - Factory: `sf spec <id> --agent` (needs the server). Poll `sf ticket show <id>` until the state is `specified` or `blocked`.
   - You: write it to a file, show it, and after the user agrees run `sf spec <id> --file <file>`.
3. **Review the spec.** Show the spec from `sf ticket show <id>`. Run `sf ready <id>` only after the user says to build it. To change it, `sf spec <id> --file <file>` replaces the spec of a `specified` ticket.
4. **Build.** The supervisor takes it from `ready` through building, verifying and reviewing to `awaiting_approval`. Do not poll in a tight loop: check `sf ticket show <id>` when the user asks, or every few minutes with a background wait. Tell the user the state and what it waits for.
5. **Gate.** At `awaiting_approval`, fetch `<dashboard>/api/tickets/<id>` (JSON with the ticket, runs, events and diff), summarize the latest review run and the diff, and give the dashboard link for the full view. Ask the user: approve, or reject with a note. At `blocked`, show the blocked reason and ask: answer, retry, reset or cancel.

## Commands

- `sf ticket list [--state <s>]`, `sf ticket show <id> [--json]`: status.
- `sf approve <id>`, `sf reject <id> --note "..."`, `sf answer <id> --text "..."`, `sf retry <id>`, `sf reset <id>`, `sf cancel <id>`.
- `sf doctor [--fix]`: check tools, clean orphan worktrees and sandboxes. Run it when something looks broken. Stop `sf serve` before `--fix`.

## Rules

- NEVER run `approve`, `reject`, `answer`, `reset` or `cancel` unless the user explicitly chose that action for that ticket in this conversation. Do not infer it from a review summary or from "looks good".
- Do not create tickets, write specs or run `sf ready` without the user's go-ahead.
- Do not implement the ticket yourself in this conversation; sf builds it in its own worktree.
- Never run git or sbx commands against factory worktrees or sandboxes. Use `sf doctor`.
- Only one `sf serve` runs at a time. A server you started in the background stops when this session ends; tell the user that if they plan to close it mid-build.
