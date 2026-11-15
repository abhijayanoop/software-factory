# Software Factory — Design

Date: 2026-11-15 · Status: draft, awaiting approval · Scope: one local user, one worker

## 1. Intent

A local-first factory, driven from Claude Code, that takes a ticket through
`ticket → specification → ready → worktree → worker → verification → review → approval → integration`
on two kinds of target repo: TypeScript/Node backends and Python AI-engineering repos.

A Claude Code worker writes the code in a git worktree, isolated in a Docker Sandbox.
The control plane drives every step deterministically and does every git operation.
**Workers never merge.** Only the control plane integrates a branch, and only after a recorded human approval.

### Goals
- Run one ticket at a time end to end, unattended between the two human gates (spec approval, merge approval).
- Treat TS and Python repos the same way, apart from a small "repo profile" (setup and check commands).
- Survive crashes. All state lives in SQLite, and any step can be re-entered safely.
- Use as few dependencies as possible.

### Non-goals (for this build)
- Parallel workers, multiple users, a remote or cloud control plane, GitHub PRs. See §10.

### Anti-goals (failure even if it "works")
- A worker, or code a worker wrote, that can change the target branch, reach the host's `.git`, or run on the host.
- An LLM deciding state transitions or gates.
- Framework creep: an ORM, a queue broker, a web framework, a state-machine library.

## 2. Environment (inspected 2026-11-15)

| Tool | Found | Use |
|---|---|---|
| Node | 24.19.0 | runs `.ts` natively (type stripping); `node:sqlite` (SQLite 3.53.3), `node:http`, `node:test`, `util.parseArgs` |
| git | 2.55 | `worktree`, `merge-tree --write-tree` |
| Docker Sandboxes `sbx` | 0.51.0 | `sbx create claude <path>`, `sbx exec`, `sbx rm`, `sbx policy`, `sbx mcp` |
| Claude Code | 2.1.325 | `claude -p --output-format stream-json` |
| uv / Python | 0.12.3 / 3.12 | Python repo profile |
| graphify | 0.9.101 | runs on the host, AST-only, before each build |

Repo: `software-factory/`, git initialised on `master`, no commits yet.

**Key constraint found.** A worktree's `.git` is a file containing an absolute Windows path
(`C:\…\.git\worktrees\T-12`), which can't be resolved inside a Linux sandbox. So **no git runs inside the
sandbox**. The worker only edits files, and the host runs all git. This also makes "workers never merge" a
structural property rather than an instruction.

## 3. Approaches considered

- **A. One server process plus a CLI that writes SQLite directly** — *chosen.* `sf serve` runs the
  supervisor loop and the dashboard. CLI commands write SQLite directly. Transitions are guarded
  compare-and-set updates (`UPDATE … WHERE id=? AND state=?`), so the CLI and the server can't race.
  Claude Code drives it through a small skill that calls `sf`.
- B. Server only, with the CLI as an HTTP client. Rejected: an internal API to maintain for a single user.
- C. Claude Code as the orchestrator (skills, hooks, MCP over SQLite). Rejected: an LLM would own the gates
  and the no-merge rule.

## 4. Architecture

```
 Claude Code session ──(/sf skill)──► sf CLI ─┐
                                              ├──► SQLite (~/.sf/sf.db, WAL)
 Browser ◄──HTTP/SSE── sf serve ──────────────┘
                         │ supervisor loop (1 worker slot)
                         ├─ git (host): worktree, commit, diff, merge-tree, integrate
                         ├─ graphify update <worktree> (host, AST-only)
                         └─ sbx create/exec/rm ──► sandbox: claude -p … | verify cmds
                                                    mount: worktree (rw) only
```

### Paths
- `~/.sf/sf.db`: the database.
- `~/.sf/worktrees/<repoId>/<ticketId>/`: worktrees, kept outside the target repo.
- `~/.sf/logs/<runId>.jsonl`: raw agent and command output. This stays out of SQLite because of its size.
- Branches: `sf/<ticketId>` (e.g. `sf/T-12`).

### Dependencies
- **Runtime: none.** Node built-ins only.
- **Dev:** `typescript` (typecheck only); dashboard: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`,
  `tailwindcss`, `@tailwindcss/vite`.
- Tests use `node:test`. No vitest, tsx, zod, express or ORM.

## 5. Modules and interfaces

```
src/
  db.ts          open(), migrate() via PRAGMA user_version, tx(fn)
  states.ts      pure transition table + guards (no I/O)
  tickets.ts     create/get/list, transition(id, from, to, event) — CAS + event row in one tx
  git.ts         host git: addWorktree, commitAll, diff, mergeCheck, integrate, removeWorktree
  sandbox.ts     Sandbox interface; SbxSandbox (real), FakeSandbox (tests only)
  agent.ts       runAgent(role, prompt, sandbox) → AgentResult (parses stream-json)
  profiles.ts    detect TS vs Python; setup + check commands
  supervisor.ts  loop: pick next actionable ticket → run one step → persist; startup recovery
  server.ts      node:http — JSON reads, SSE events, POST approve/reject/answer
  cli.ts         sf <command>
  prompts/       spec.md, build.md, review.md (worker charter lives here)
web/             React + Vite + Tailwind dashboard (built to web/dist, served by sf serve)
skill/SKILL.md   /sf skill for Claude Code
```

Key interfaces:

```ts
type TicketState = 'new'|'specifying'|'specified'|'ready'|'preparing'|'building'
  |'verifying'|'reviewing'|'awaiting_approval'|'integrating'|'done'|'blocked'|'cancelled';

interface Sandbox {
  create(name: string, worktree: string): Promise<void>;        // idempotent
  exec(name: string, cmd: string[], o: { timeoutMs: number; logPath: string }): Promise<{ code: number }>;
  remove(name: string): Promise<void>;                          // idempotent
}

type AgentRole = 'spec' | 'build' | 'review';
interface AgentResult {
  ok: boolean;
  kind: 'done' | 'needs_human' | 'rate_limited' | 'error' | 'timeout';
  summary: string;            // final message
  question?: string;          // when kind = needs_human
  findings?: Finding[];       // review role only
  costUsd?: number;
}
interface Finding { severity: 'blocking' | 'major' | 'minor'; file?: string; line?: number; text: string }

interface RepoProfile {
  kind: 'ts' | 'py';
  setup: string[][];          // e.g. [['npm','ci']]  |  [['uv','sync']]
  checks: { name: string; cmd: string[] }[];  // typecheck/lint/test | ruff/pytest
}

// tickets.ts — the only way state changes
function transition(id: string, from: TicketState, to: TicketState,
                    event: { type: string; data?: unknown; runId?: string }): boolean; // false = lost race
```

### Boundary rules
- `states.ts` holds the transition table. `tickets.transition` refuses any pair the table doesn't list.
- Only `supervisor.ts` starts runs. The CLI and server only perform human transitions:
  `ready`, `approve`, `reject`, `answer`, `retry`, `cancel`.
- Only `git.ts` calls git, and only on the host.
- Only `sandbox.ts` calls `sbx`.

## 6. SQLite schema

```sql
PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
-- PRAGMA user_version tracks migrations

CREATE TABLE repos (
  id            TEXT PRIMARY KEY,          -- short slug
  path          TEXT NOT NULL UNIQUE,      -- primary checkout on host
  target_branch TEXT NOT NULL,             -- e.g. main
  profile_json  TEXT NOT NULL,             -- RepoProfile, confirmed by user at `sf repo add`
  created_at    TEXT NOT NULL
);

CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,          -- T-1, T-2 …
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,             -- the ask
  spec          TEXT,                      -- markdown incl. acceptance criteria
  state         TEXT NOT NULL,
  blocked_from  TEXT,                      -- state to return to on retry
  blocked_reason TEXT,
  human_note    TEXT,                      -- latest reject reason / answer, fed into next prompt
  branch        TEXT,
  worktree_path TEXT,
  base_sha      TEXT,                      -- target tip when worktree was made
  head_sha      TEXT,                      -- last host commit on branch
  attempt       INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX tickets_state ON tickets(state);

CREATE TABLE runs (                         -- the worker state machine (one row per step execution)
  id            INTEGER PRIMARY KEY,
  ticket_id     TEXT NOT NULL REFERENCES tickets(id),
  kind          TEXT NOT NULL,             -- spec|build|verify|review|integrate
  state         TEXT NOT NULL,             -- starting|running|succeeded|failed|lost|cancelled
  sandbox       TEXT,                      -- sbx name
  pid           INTEGER,                   -- host pid of sbx/claude child, for recovery
  result_json   TEXT,                      -- AgentResult / check results
  log_path      TEXT,
  started_at    TEXT NOT NULL,
  heartbeat_at  TEXT,
  ended_at      TEXT
);
CREATE INDEX runs_ticket ON runs(ticket_id);

CREATE TABLE events (                       -- append-only audit; approvals live here
  id         INTEGER PRIMARY KEY,
  ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  run_id     INTEGER REFERENCES runs(id),
  type       TEXT NOT NULL,                -- transition|approval|rejection|answer|note
  from_state TEXT, to_state TEXT,
  actor      TEXT NOT NULL,                -- human|supervisor
  data_json  TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX events_ticket ON events(ticket_id);
```

Four tables, no settings table. Defaults (timeouts, retries) are constants in code.

## 7. State machines

### Ticket

```
new ──spec run──► specifying ──► specified ──(human: sf ready)──► ready
 └──(human: sf spec --file)──────► specified

ready ──► preparing (host: worktree + setup in sandbox + graphify)
      ──► building  (worker)
      ──► verifying (checks in sandbox)
      ──► reviewing (review agent, read-only)
      ──► awaiting_approval ──(human: approve)──► integrating ──► done
                            └─(human: reject + note)──► ready (attempt reset to 0, same worktree)

verifying ──fail──► building  (attempt+1, failure tail fed back)
reviewing ──blocking findings──► building (attempt+1)
building  ──needs_human──► blocked (question shown; `sf answer` → ready)
any active ──attempt > max | infra failure | merge conflict──► blocked (blocked_from set)
blocked ──(human: retry)──► blocked_from        any non-terminal ──(human: cancel)──► cancelled
```

Rules:
- `done` and `cancelled` are terminal.
- Human gates: `specified→ready`, `awaiting_approval→integrating|ready`, every exit from `blocked`.
- `integrating` requires an `approval` event recorded for the current `head_sha`.
  Approving and then letting the code change is impossible.

### Worker (a run row)

```
starting ──► running ──► succeeded
                    ├──► failed     (non-zero / agent error / timeout)
                    ├──► cancelled  (human cancel → kill child, sbx stop)
                    └──► lost       (found running at startup with dead pid)
```

There's one worker slot. The supervisor starts a run only when no run is `starting|running`.
A heartbeat updates `heartbeat_at` every 15 s while the child process lives.

## 8. Worker contract

- **Host git never trusts the worktree's `.git` file.** Every host git call passes `--git-dir`/`--work-tree` explicitly.
- **Spec run.** The sandbox mounts a detached worktree at the target tip, read-only (`path:ro`). It never mounts
  the primary checkout, which contains the host `.git`. The agent writes
  the spec (context, approach, acceptance criteria as a checklist, files likely touched, verification notes)
  as its final message. The host stores it. Alternatively, the human writes it with `sf spec T-1 --file spec.md`.
- **Build run.** `claude -p` runs inside the sandbox with `--output-format stream-json`, an appended system
  prompt from `prompts/build.md`, and the ticket spec, previous failure output and `human_note`.
  It runs with `--dangerously-skip-permissions`, because the sandbox is the boundary.
  The worker ends with a final JSON line `{"status":"done"|"needs_human","summary":…,"question":…}`.
  After a successful run, the host commits everything in the worktree to `sf/<id>`.
- **Verify.** The profile's setup and check commands run in the **sandbox**, because worker-written tests
  are untrusted code. All checks must exit 0.
- **Review run.** A fresh agent receives the spec plus `git diff base_sha..head_sha` (produced by the host),
  with the worktree mounted read-only. It returns `findings[]`. Any `blocking` finding sends the ticket back
  to building. Everything else is shown to the human at approval.
- **Integrate (host).**
  1. `git merge-tree --write-tree <target> sf/<id>`. A conflict sends the ticket to `blocked`.
  2. If the target moved since `base_sha`, build the merged tree in a temporary worktree and re-run checks in a sandbox.
  3. **Squash** *(design call)*: `commit-tree` the merged tree on the target tip as one commit.
     Message: `T-12: <title>` plus a `Factory-Ticket: T-12` trailer. Author: the repo's configured git user.
     The approval covers `head_sha`. If the target moved, the re-verified squash commit integrates
     without a second approval; a failed re-verify blocks the ticket.
  4. Advance the target. If it's checked out in a clean worktree, use `git -C <checkout> merge --ff-only <squashCommit>`.
     If it isn't checked out, use `git update-ref refs/heads/<target> <new> <old>` (a compare-and-set).
     If its checkout is dirty, the ticket goes to `blocked` with a message.
  5. Clean up: remove the worktree and the sandbox. The branch is kept.

**Retry budget** *(design call)*: `attempt` counts automatic retries only (verify failures, blocking review
findings, timeouts) and caps at 3. A human reject or answer resets it to 0, so people are pulled in only
when automation is truly stuck.

### Tooling the worker gets

| Tool | How |
|---|---|
| Karpathy principles + Ponytail | Inlined into `prompts/build.md` as the worker charter: think first, simplest complete change, surgical diffs, verify against acceptance criteria. Plain text needs no plugin. |
| Superpowers (TDD, verification-before-completion) | Through `sbx --skills readonly` if plugins load in the sandbox (day-1 spike). Otherwise the few needed rules go into the charter. |
| Context7 | `sbx mcp add context7`, then `--static-mcp context7` at sandbox create. |
| Graphify | The host runs `graphify update <worktree>` during `preparing`. The charter tells the worker to read `graphify-out/GRAPH_REPORT.md` first. If the target repo doesn't track `graphify-out/`, the host excludes it from commits. |

## 9. Security boundaries and failure recovery

### Trust zones
1. **Host control plane (trusted):** `sf`, SQLite, git, graphify.
2. **Sandbox (untrusted):** agent output, worker-written code, tests, install scripts.
3. **Human:** the only actor that can pass gates.

### Boundaries
- The sandbox mounts only that ticket's worktree (rw), or the primary checkout (ro) for spec runs.
  The host `.git`, `~`, `~/.sf` and other repos are never mounted.
- No git inside the sandbox and no git credentials, so the worker can't push, merge or touch other branches.
- **No worker-writable file is ever executed on the host.**
  - Host commits use `git -c core.hooksPath=<empty dir> commit --no-verify`. Husky and other in-repo hooks
    are worker-writable.
  - Install and test commands run only in the sandbox.
  - `graphify update` is a parser, not an executor.
- Egress uses `sbx policy`: allow the Anthropic API, the npm and PyPI registries, and Context7. Deny the rest
  (to be confirmed in the spike). Target repos need no extra services or secrets for their checks (user-confirmed).
- **Claude auth: the user's Claude subscription** (user decision). `sf` stores no credentials.
  - The spike must prove a fresh sandbox can run `claude -p` unattended on that login.
  - Preferred: a long-lived token from `claude setup-token`, held in `sbx secret` (custom secret) and
    brokered into each sandbox.
  - Fallback: one long-lived per-repo sandbox, logged in once. The current ticket's worktree is created under
    a mounted `~/.sf/worktrees/<repo>/` directory, and the worker is pinned to that ticket's folder with `--workdir`.
  - Under a subscription, `costUsd` is informational only. Usage-limit handling (`rate_limited`) is the main signal.
- The dashboard binds `127.0.0.1` only. Mutating POSTs require `Content-Type: application/json` and an
  `Origin` matching the server, which blocks drive-by CSRF from other local pages. React escaping only;
  no raw HTML rendering of diffs or logs.
- Input validation happens at the CLI and HTTP edges: ticket ids are matched by regex, repo paths must be
  existing git repos, and state names are checked against the table.

### Failure recovery

| Failure | Response |
|---|---|
| `sf serve` crashes or the machine reboots | At startup, any `starting/running` run whose pid is dead becomes `lost`. The ticket stays in its active state and the step is re-dispatched. The worktree keeps partial edits, and the build prompt says "partial work may exist". |
| Worker hangs | Hard timeout per run kind (build 45 min, verify 15, review 15) kills the run and marks it `failed`. It counts as an attempt. |
| Claude usage limit | `kind:'rate_limited'` doesn't count as an attempt. The supervisor pauses dispatch until the reset time it parsed, or for 30 min by default. |
| Sandbox create/exec fails (code 125) | Retry once, then `blocked` (infra) with the error. |
| Checks fail | Back to `building` with the last 200 log lines. After `max_attempts`, `blocked`. |
| Merge conflict / target moved and recheck fails | `blocked`. The human chooses: `sf retry` (re-run from `blocked_from`) or `sf reset T-n` (fresh worktree from the current target tip). |
| CLI and server race | CAS transition returns false and the loser re-reads. |
| Leaked worktree or sandbox | `sf doctor` lists worktrees and sandboxes with no live ticket and offers to remove them. |

Every step is idempotent: create-if-missing for worktrees and sandboxes, commit-only-if-dirty.

## 10. Three-day implementation plan

**Day 1 — Spike + foundations**
1. Spike (timeboxed to 2 h): `sbx create claude <worktree>` then `sbx exec … claude -p --output-format stream-json`.
   Confirm:
   - a fresh sandbox runs `claude -p` unattended on the Claude subscription (setup-token via `sbx secret`, else the fallback in §9)
   - edits are visible on the host
   - `npm ci && npm test` and `uv sync && uv run pytest` run in the default image (otherwise use a template)
   - Context7 MCP works
   - whether Superpowers plugins load
   - egress policy
2. Repo scaffolding: `package.json`, `tsconfig`, `node --test`.
3. `db.ts` + schema + migration. `states.ts` + table tests. `tickets.ts` CAS transition + tests.
4. `git.ts` (worktree, commitAll with hooks disabled, diff, merge-tree, integrate CAS), tested against temp repos.
5. CLI: `sf repo add`, `sf ticket add|list|show`, `sf spec --file`, `sf ready`.

*Exit criteria:* a ticket reaches `ready` and `preparing` creates a worktree.

**Day 2 — Worker, verification, review**
1. `sandbox.ts` (Sbx + Fake), `agent.ts` stream-json parser + final-line contract, `profiles.ts` (TS/Python detection).
2. `supervisor.ts`: preparing → building → verifying → reviewing → awaiting_approval; retries, timeouts,
   rate-limit pause, startup recovery.
3. `prompts/` charter (Karpathy/Ponytail), spec run, review run.
4. Full fake-agent test of the happy path and each failure path. Real run on a sample TS repo and a sample Python repo.

*Exit criteria:* real tickets reach `awaiting_approval` on both repo types.

**Day 3 — Approval, integration, dashboard, skill**
1. `approve` / `reject` / `answer` / `retry` / `cancel` / `reset`. `integrate` with re-verify when the target moved.
2. `server.ts`: board, ticket detail, SSE event stream, log tail, POST actions with an Origin check.
3. `web/`: board by state; ticket page with spec, diff, check results, findings, and Approve/Reject.
4. `skill/SKILL.md` for `/sf`. `sf doctor` (sbx, claude, git, uv, graphify, orphan cleanup).
5. End-to-end demo on both repo types. README.

*Exit criteria:* approve in the dashboard → the target branch advances; worker code never touched `.git`.

## 11. Deferred (explicitly out of scope)

- More than one worker, parallel tickets, ticket dependencies.
- Multiple users, auth, remote access, hosting the control plane anywhere but localhost.
- GitHub/GitLab PRs, CI integration, pushing to remotes.
- Automatic conflict resolution or rebasing by an agent.
- Turning a PRD into a ticket list, an interview flow, or epics.
- Live mid-run questions or chat with the worker. For now: end the run with `needs_human`, then `sf answer`.
- Cost budgets, analytics, token dashboards.
- Notifications (desktop or phone).
- A settings UI. Per-repo config lives in `profile_json`, edited through the CLI.
- Cloud sandboxes (`sbx --cloud`), other agents (Codex etc.), a host-mode worker without a sandbox.
- Log retention and rotation.
- Other languages and package managers beyond npm/pnpm and uv.

## 12. Left to the builder

- The exact stream-json fields for cost and rate-limit detection (confirm against the CLI's real output in the spike).
- Dashboard layout and styling.
- Whether pnpm is detected as well as npm (cheap: lockfile check).
- How check output is truncated for prompts (default: last 200 lines).
- Sandbox naming (`sf-<repo>-<ticket>`) and whether one sandbox is reused across a ticket's runs (default: yes, removed at done/cancel).
