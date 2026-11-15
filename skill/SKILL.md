---
name: sf
description: Use when the user wants to run tickets through the local software factory (sf) - add repos or tickets, write or generate specs, mark tickets ready, check status, or approve, reject or answer a ticket.
---

# sf: local software factory

Run commands as `sf <cmd>` if linked, otherwise `node <factory-repo>/src/cli.ts <cmd>`.

## Commands

- `sf doctor [--fix]`: check tools and clean orphan worktrees and sandboxes. Run this first when something looks broken.
- `sf repo add <path> [--id <id>] [--target <branch>]`: register a repo. It prints the detected profile (setup and check commands).
- `sf repo profile <repoId> --file <profile.json>`: replace the profile after the user corrects it.
- `sf ticket add <repoId> --title "..." (--body "..." | --body-file <f>)`: prints the new ticket id.
- `sf ticket list [--state <s>]`, `sf ticket show <id> [--json]`: read status.
- `sf spec <id> --agent`: have the factory write the spec. `sf spec <id> --file <spec.md>`: use a spec you wrote.
- `sf ready <id>`: queue a specified ticket for the build.
- `sf serve [--port 4400]`: run the supervisor and dashboard. It runs until stopped.
- `sf approve <id>`, `sf reject <id> --note "..."`, `sf answer <id> --text "..."`, `sf retry <id>`, `sf reset <id>`, `sf cancel <id>`.

## Rules

- After `sf repo add`, show the user the printed profile and ask for confirmation. Fix it with `sf repo profile` if they object.
- NEVER run `approve`, `reject`, `answer`, `reset` or `cancel` unless the user explicitly chose that action for that ticket in this conversation. Do not infer it from a review summary or from "looks good".
- Do not write or edit specs the user did not ask for. Show a spec you wrote before `sf ready`.
- Never run git or sbx commands against factory worktrees or sandboxes yourself. Use `sf doctor`.

## Starting the server

Start `sf serve` in the background (for example with `run_in_background`). Read its first output line, `sf serve: http://127.0.0.1:<port>`, and give that URL to the user. Approvals and reviews happen on the dashboard there. Only one `sf serve` can run at a time; a second one fails on the lock.

## Status

Use `sf ticket list` for an overview. For a single ticket, `sf ticket show <id>` and tell the user its state and what it waits for (blocked reason, awaiting approval, and so on).
