# Software Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local `sf` tool that takes one ticket at a time from spec to an integrated squash commit. A Claude Code worker builds the ticket inside a Docker Sandbox, and two human gates sit in the flow.

**Architecture:** One Node process (`sf serve`) runs the supervisor loop and a localhost dashboard. The `sf` CLI writes the same SQLite file directly, and state changes are guarded compare-and-set updates. All git runs on the host. Workers only edit files, inside `sbx` sandboxes.

**Tech Stack:**
- Node 24: native `.ts`, `node:sqlite`, `node:http`, `node:test`, `util.parseArgs`.
- TypeScript, for typecheck only.
- React + Vite + Tailwind for the dashboard.
- Docker Sandboxes `sbx`, Claude Code CLI, git 2.55, uv, graphify.

**Spec:** `docs/superpowers/specs/2026-11-15-software-factory-design.md`. Read it before any task. Section refs (§) below point into it.

## Global Constraints

- **Runtime:** zero runtime dependencies. Node built-ins only.
- **Dev dependencies:** only `typescript`, `@types/node`, `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`.
- **TS syntax:** erasable syntax only (no `enum`, no parameter properties, no namespaces). Relative imports end in `.ts`. `tsconfig`: `"module": "nodenext"`, `"allowImportingTsExtensions": true`, `"noEmit": true`, `"erasableSyntaxOnly": true`, `"strict": true`.
- **Tests:** `node --test`, with test files at `src/**/*.test.ts`. Default tests never call real `sbx` or `claude`.
- **Home directory:** `SF_HOME` env, defaulting to `~/.sf`, holds `sf.db`, `worktrees/<repoId>/<ticketId>/`, `logs/<runId>.jsonl` and `serve.lock`.
- **Branches and sandboxes:** branch `sf/<ticketId>`; sandbox name `sf-<repoId>-<ticketId>`. Ticket ids match `/^T-\d+$/`.
- **Child processes:** `spawn`/`execFile` with argument arrays and `shell: false`. User text is never interpolated into a command string.
- **Host git:** every call passes `--git-dir=<common .git>` and, where a work tree is needed, `--work-tree=<path>`. Commits use `-c core.hooksPath=<SF_HOME>/empty-hooks commit --no-verify`.
- **Timeouts:** build 45 min, verify 15 min, review 15 min, spec 15 min.
- **Retries:** `max_attempts` = 3 automatic retries. A human reject or answer resets `attempt` to 0. Check output fed back to the worker is the last 200 lines.
- **Rate limits:** default pause is 30 min when no reset time is parsed. Heartbeat every 15 s. Supervisor idle poll every 2 s.
- **Server:** binds `127.0.0.1`, default port `4400`. Mutating requests require `Content-Type: application/json` and an `Origin` equal to `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- **Squash commits:** message `T-<n>: <title>` + blank line + `Factory-Ticket: T-<n>`. Author is the repo's configured git user.

## Review Focus

1. **Ticket text with quotes, `$()`, backticks or newlines must reach the worker verbatim and never run.** Pinned in Task 6: `buildSbxExecArgs` keeps it as one argv element or on stdin.
2. **Paths with spaces**, for the repo, `SF_HOME` and worktrees. Pinned in Task 4: git tests run in a temp dir containing a space.
3. **A second `sf serve` while one is running must refuse to start, not start a second worker.** Pinned in Task 10: lock test.
4. **The worker deleting or rewriting the worktree's `.git` file must not break host commits or redirect them.** Pinned in Task 4.
5. **CRLF churn.** With Windows `core.autocrlf=true` and a Linux sandbox writing LF, a diff must not show every line changed. Pinned in Task 4: an autocrlf commit test asserts the diff touches only the edited lines.

---

### Task 0: Sandbox spike (timebox 2 h, no production code)

**Files:**
- Create: `docs/spike-notes.md`
- Create: `src/fixtures/stream-done.jsonl`, `src/fixtures/stream-rate-limited.jsonl` (real captured output)

**Interfaces:**
- Produces: the decisions recorded in `docs/spike-notes.md`, which Tasks 6 and 8 read. They cover the auth route, the image or template, how the prompt is delivered, the context7 flag, and the stream-json field names for the final result, cost and rate limit.

- [ ] **Step 1:** In a scratch repo, `git worktree add` a worktree, then `sbx create claude <worktree> --name sf-spike`.
- [ ] **Step 2:** Auth. Run `claude setup-token` on the host. Store the token with `sbx secret set-custom` (or `sbx secret set anthropic` if that accepts an OAuth token). Then `sbx exec -i sf-spike claude -p --output-format stream-json --verbose --dangerously-skip-permissions` with the prompt on stdin, in a **fresh** sandbox.
  Expected: it completes without an interactive login.
  If not, test the §9 fallback: one long-lived sandbox mounting `SF_HOME/worktrees/<repo>/`, with `--workdir`.
- [ ] **Step 3:** Ask the agent to create `hello.txt`. Confirm the file appears on the host.
- [ ] **Step 4:** In the sandbox, run `node -v`, `npm -v`, `uv --version`, `python3 --version`. If uv or python is missing, record the template needed (`sbx template`).
- [ ] **Step 5:** `sbx mcp add context7` + recreate with `--static-mcp context7`. Ask the agent to resolve a library id. Then check whether Superpowers plugins appear (`claude -p "/help"` or a skill invocation). Record yes or no.
- [ ] **Step 6:** Apply a deny-by-default egress policy (`sbx policy`) that allows Anthropic, npmjs, PyPI and context7. Confirm `curl https://example.com` fails inside the sandbox.
- [ ] **Step 7:** Save one complete successful stream-json output as `src/fixtures/stream-done.jsonl`. If you can capture a usage-limit output, save it as `stream-rate-limited.jsonl`; otherwise hand-write one from the documented shape and say so in the notes.
- [ ] **Step 8:** Write `docs/spike-notes.md` with every finding and the exact commands that worked. **Stop and report to the user if neither auth route runs unattended**, because Day 2 depends on it.
- [ ] **Step 9:** `sbx rm sf-spike`. Commit the notes and fixtures.

### Task 1: Project scaffold + database

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (`node_modules`, `web/dist`)
- Create: `src/types.ts`, `src/db.ts`
- Test: `src/db.test.ts`

**Interfaces:**
- Produces:
  - `openDb(path: string): DatabaseSync`. Sets WAL, `busy_timeout=5000`, `foreign_keys=ON`, then migrates.
  - `tx<T>(db: DatabaseSync, fn: () => T): T`. Wraps `BEGIN IMMEDIATE` … `COMMIT` / `ROLLBACK`.
  - `now(): string`, returning ISO 8601.
  - `sfHome(): string`.
  - `types.ts` exports `Repo`, `Ticket`, `Run`, `Event`, `RepoProfile`, `AgentRole`, `AgentResult`, `Finding` with the fields in spec §5–§6. Row fields use camelCase (`repoId`, `worktreePath`, …). `db.ts` maps snake_case columns.
- `package.json` scripts: `"test": "node --test \"src/**/*.test.ts\""`, `"typecheck": "tsc --noEmit"`, `"build:web": "vite build web"`. Bin: `"sf": "src/cli.ts"`.

- [ ] **Step 1:** Write the failing test `openDb creates schema v1`.
  - `openDb(':memory:')`. Then `sqlite_master` lists `repos`, `tickets`, `runs`, `events`, and `PRAGMA user_version` is `1`.
  - A second migrate on the same db is a no-op.
- [ ] **Step 2:** Write `tx rolls back on throw`. Insert a repo inside `tx`, throw, and assert the count is 0.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL (module not found).
- [ ] **Step 4:** Implement `db.ts` with the exact schema SQL from spec §6, plus `types.ts`.
- [ ] **Step 5:** Run `npm test && npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 6:** Commit `feat: scaffold and sqlite schema`.

### Task 2: Ticket state table

**Files:**
- Create: `src/states.ts`
- Test: `src/states.test.ts`

**Interfaces:**
- Produces:
  - `type TicketState` (13 values from spec §5).
  - `TRANSITIONS: Record<TicketState, TicketState[]>`.
  - `HUMAN: Set<string>` of `"from>to"` keys.
  - `canTransition(from, to): boolean`.
  - `isHumanTransition(from, to): boolean`.
  - `ACTIVE: TicketState[]`: the states the supervisor acts on. These are `specifying`, `preparing`, `building`, `verifying`, `reviewing`, `integrating`, plus `ready`, which the supervisor moves to `preparing`.

- [ ] **Step 1:** Write the tests.
  - `canTransition` is true for every edge in spec §7, including `new→specified`, `awaiting_approval→ready`, `verifying→building`, `reviewing→building`, `building→blocked`, and `<any non-terminal>→cancelled`.
  - It is false for `building→done`, `done→ready`, `cancelled→ready`, and `ready→integrating`.
  - `isHumanTransition('specified','ready')` and `isHumanTransition('awaiting_approval','integrating')` are true. `isHumanTransition('building','verifying')` is false.
  - Every exit from `blocked` is human.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `states.ts` as plain data plus the two functions. From `blocked` the table allows any non-terminal state; `tickets.transition` restricts it to `blocked_from`, or `ready` for an answer or reset.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: ticket state table`.

### Task 3: Repos and tickets store

**Files:**
- Create: `src/store.ts`
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: `openDb`, `tx`, `now`, `canTransition`.
- Produces:
  - `addRepo(db, r: { id: string; path: string; targetBranch: string; profile: RepoProfile }): Repo`
  - `getRepo(db, id): Repo | undefined`
  - `createTicket(db, t: { repoId: string; title: string; body: string }): Ticket`. Ids are `T-<max+1>`.
  - `getTicket(db, id): Ticket | undefined`
  - `listTickets(db, filter?: { state?: TicketState }): Ticket[]`
  - `transition(db, id, from, to, ev: { type: string; actor: 'human' | 'supervisor'; runId?: number; data?: unknown }, patch?: Partial<Ticket>): boolean`
    - Throws on an illegal pair. Returns false when the current state ≠ `from`.
    - Sets `blocked_from = from` when `to === 'blocked'`.
    - Applies `patch` and writes the event row in the same `tx`.
  - `patchTicket(db, id, expectedState, patch: Partial<Ticket>): boolean`. A CAS update with no state change, used for in-place retries such as `attempt+1` while staying in `building`.
  - `startRun(db, ticketId, kind, sandbox?): Run`, `heartbeat(db, runId, pid?)`, `finishRun(db, runId, state, result?: unknown)`, `activeRun(db): Run | undefined`
  - `events(db, ticketId): Event[]`, `eventsSince(db, afterId: number): Event[]`

- [ ] **Step 1:** Write the tests.
  - `transition CAS`: two calls with the same `from`. The first returns true, the second false, and there's exactly one event row.
  - `transition illegal throws`: `new→done` throws `/illegal transition/`.
  - `blocked records blocked_from`.
  - `patch applied atomically`: patch `{ attempt: 2 }` is visible after a successful transition, and unchanged after a failed CAS.
  - `createTicket ids increment`: T-1, then T-2.
  - `activeRun returns starting|running only`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `store.ts`. The CAS is `UPDATE tickets SET state=?, … WHERE id=? AND state=?`; check `changes === 1`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: repos, tickets, runs store with CAS transitions`.

### Task 4: Host git

**Files:**
- Create: `src/git.ts`
- Test: `src/git.test.ts` (temp repos under `os.tmpdir()/sf test <rand>/`, a path with a space)

**Interfaces:**
- Produces (all async, all via `execFile('git', args)` with explicit `--git-dir`/`--work-tree`):
  - `commonGitDir(repoPath): Promise<string>`
  - `addWorktree(repoPath, wtPath, branch, baseRef): Promise<{ baseSha: string }>`. Idempotent: an existing worktree on that branch returns its merge-base.
  - `addDetachedWorktree(repoPath, wtPath, ref): Promise<void>`
  - `commitAll(repoPath, wtPath, message): Promise<string | null>`. Returns the new sha, or null if clean. Hooks are disabled.
  - `diff(repoPath, base, head): Promise<string>`
  - `revParse(repoPath, ref): Promise<string>`
  - `mergeTree(repoPath, target, branch): Promise<{ tree: string } | { conflict: string[] }>`
  - `squashCommit(repoPath, tree, parent, message): Promise<string>`. Uses `commit-tree`.
  - `advanceTarget(repoPath, target, newSha, oldSha): Promise<'ok' | 'dirty' | 'moved'>`
    - If the target is checked out in a clean worktree: `merge --ff-only` there.
    - If that checkout is dirty: `'dirty'`.
    - If it isn't checked out: `update-ref refs/heads/<t> new old`, which fails as `'moved'`.
  - `removeWorktree(repoPath, wtPath): Promise<void>`. Idempotent.

- [ ] **Step 1:** Write the tests.
  - `addWorktree creates branch sf/T-1 at base` (and it's idempotent).
  - `commitAll returns null when clean`.
  - `commitAll ignores repo hooks`: set `core.hooksPath=.husky` and make `.husky/pre-commit` write `HOOK_RAN`. After commit, `HOOK_RAN` is absent.
  - `commitAll works after worker deletes .git file`: delete `<wt>/.git`, then commitAll still commits to `sf/T-1`.
  - `autocrlf does not churn`: with `core.autocrlf=true`, a committed CRLF file is edited by writing LF content with one changed line. `diff` shows 1 changed line.
  - `mergeTree reports conflict`.
  - `squash + advanceTarget ok when target not checked out` (the parent is the old tip, and the message matches the Global Constraints format).
  - `advanceTarget dirty`.
  - `advanceTarget moved when oldSha stale`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `git.ts`. If the autocrlf test fails, fix it by passing `-c core.autocrlf=false -c core.safecrlf=false` together with `.gitattributes` respect, and note why in a one-line comment.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: host git operations`.

### Task 5: Repo profiles + CLI (part 1)

**Files:**
- Create: `src/profiles.ts`, `src/cli.ts`
- Test: `src/profiles.test.ts`, `src/cli.test.ts` (spawns `node src/cli.ts` with a temp `SF_HOME`)

**Interfaces:**
- Consumes: the store and `git.revParse`.
- Produces:
  - `detectProfile(repoPath): RepoProfile`
    - TS (`package.json`):
      - `pnpm-lock.yaml` → setup `[['pnpm','install','--frozen-lockfile']]`.
      - Otherwise `[['npm','ci']]`.
      - Checks are each of `typecheck`, `lint`, `test` present in `scripts`, as `[pm,'run',name]`.
    - Python (`pyproject.toml`): setup `[['uv','sync']]`. Checks: `['uv','run','ruff','check','.']` if `ruff` appears in pyproject, and `['uv','run','pytest']` if `pytest` appears.
    - Neither, or no checks found: throws `no checks detected`.
  - CLI commands (via `parseArgs`). Exit 0 on success; 1 with a message on stderr otherwise.
    - `sf repo add <path> [--id <slug>] [--target <branch>]`. Prints the profile JSON; the target defaults to the current branch.
    - `sf repo profile <id> --file <json>`
    - `sf ticket add <repoId> --title <t> (--body <b> | --body-file <f>)`. Prints the id.
    - `sf ticket list [--state <s>]`
    - `sf ticket show <id>`
    - `sf spec <id> --file <md>`: `new→specified`.
    - `sf spec <id> --agent`: `new→specifying`.
    - `sf ready <id>`: `specified→ready`.
  - Validation: the ticket id regex, the repo path is a git repo, `--state` is a known state.

- [ ] **Step 1:** Write the tests.
  - Profiles: fixture dirs built in the test cover npm with `typecheck`+`test`, pnpm, Python with ruff+pytest, and empty → throws.
  - CLI:
    - `repo add → ticket add → spec --file → ready` ends in `state === 'ready'` (via `ticket show --json`).
    - `ready on a new ticket exits 1 with "illegal transition"`.
    - `ticket add with title containing "$(rm -rf ~)" stores it verbatim`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: repo profiles and ticket CLI`.

### Task 6: Sandbox + agent adapters

**Files:**
- Create: `src/sandbox.ts`, `src/agent.ts`
- Test: `src/sandbox.test.ts`, `src/agent.test.ts` (use the Task 0 fixtures)

**Interfaces:**
- Consumes: `docs/spike-notes.md` (the auth route, flags and field names).
- Produces:
  - `interface Sandbox`:
    - `create(name: string, mounts: { path: string; ro?: boolean }[]): Promise<void>`
    - `exec(name, argv: string[], o: { stdin?: string; timeoutMs: number; logPath: string; onPid?: (pid: number) => void }): Promise<{ code: number; timedOut: boolean }>`
    - `remove(name): Promise<void>`
  - `class SbxSandbox implements Sandbox`, plus the exported pure helpers `buildSbxCreateArgs(name, mounts)` and `buildSbxExecArgs(name, argv)`.
  - `class FakeSandbox implements Sandbox`. Its constructor takes `script: (argv: string[]) => { code: number; stdout?: string }`. It records `calls` and writes stdout to `logPath`.
  - `runAgent(sb: Sandbox, name: string, role: AgentRole, prompt: string, logPath: string, onPid?): Promise<AgentResult>`
    - Runs `claude -p --output-format stream-json --verbose --dangerously-skip-permissions` (+ `--append-system-prompt` for the role).
    - The prompt goes on stdin.
    - Role timeouts come from Global Constraints.
  - `parseStream(jsonl: string): AgentResult`
    - The final `result` event's text must end with a JSON line `{"status":"done"|"needs_human","summary":…,"question"?:…,"findings"?:[…]}`.
    - A missing or invalid final line gives `kind:'error'`.
    - Usage-limit markers (field names from the spike) give `kind:'rate_limited'` with `resetAt?: string`.
    - A timeout gives `kind:'timeout'`.

- [ ] **Step 1:** Write the tests.
  - `buildSbxExecArgs keeps prompt off argv` (the prompt is passed via `stdin`; argv has no ticket text).
  - `buildSbxCreateArgs maps ro mounts to PATH:ro and adds --static-mcp context7`.
  - `parseStream(stream-done.jsonl)` gives `kind:'done'` with a summary.
  - `parseStream(stream-rate-limited.jsonl)` gives `kind:'rate_limited'`.
  - `parseStream` with the final line missing gives `kind:'error'`.
  - `runAgent with FakeSandbox timeout` gives `kind:'timeout'`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `SbxSandbox.create` also applies whatever egress-policy and auth-secret commands the spike notes record as per-sandbox (global ones belong in the README setup instead). `SbxSandbox.exec` uses `spawn('sbx', args, { shell: false })` and pipes stdout/stderr to `logPath`. On timeout it kills the process tree, using `taskkill /T /F` on win32.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: sbx sandbox and claude agent adapters`.

### Task 7: Prompts (worker charter)

**Files:**
- Create: `src/prompts/build.md`, `src/prompts/spec.md`, `src/prompts/review.md`, `src/prompts.ts`
- Test: `src/prompts.test.ts`

**Interfaces:**
- Produces:
  - `systemPrompt(role: AgentRole): string`, which reads the `.md` file.
  - `taskPrompt(role, t: Ticket, extra: { failureTail?: string; diff?: string; partialWork?: boolean }): string`

**Charter content (`build.md`):**
- Karpathy:
  - Think before coding: state your assumptions.
  - Simplest complete change; nothing speculative.
  - Surgical diffs: touch only what the ticket needs.
  - Define success as the acceptance criteria and verify against them.
- Ponytail: reuse existing code before writing new code, no new dependencies without need, test-first for logic.
- Tooling:
  - Read `graphify-out/GRAPH_REPORT.md` first if it exists.
  - Use context7 for library APIs.
  - Never run git. The host handles it.
- Output contract: the final line must be the JSON object from Task 6. Use `needs_human` with a `question` when blocked on a decision.

`review.md` asks for findings with `severity` ∈ `blocking|major|minor`. `blocking` is only for an unmet acceptance criterion, a bug or a security issue.

- [ ] **Step 1:** Write the tests.
  - The `taskPrompt('build')` output contains the ticket spec, `human_note`, the `failureTail`, and the literal `"status"` contract line.
  - `partialWork:true` adds the sentence "Partial work from an interrupted run may exist in this folder."
  - `taskPrompt('review')` contains the diff.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: worker charter and prompts`.

### Task 8: Supervisor — pipeline to approval

**Files:**
- Create: `src/supervisor.ts`
- Test: `src/supervisor.test.ts` (temp git repo + `FakeSandbox` + a profile whose checks are `['check','a']`, scripted in the fake)

**Interfaces:**
- Consumes: store, git, `Sandbox`, `runAgent`, prompts, `detectProfile` (via the repo row).
- Produces:
  - `type Deps = { db; sandbox: Sandbox; graphify?: (wt: string) => Promise<void>; clock?: () => Date }`
  - `step(deps): Promise<'worked' | 'idle' | 'paused'>`
    - If `activeRun` exists or a pause is active, return without starting anything.
    - Otherwise pick the oldest-`updated_at` ticket in `ACTIVE` and run one stage.
  - Stage handlers (internal):
    - `specifying`: spec run. Mount a detached worktree at the target tip as `ro`, store `spec`, go to `specified`.
    - `ready → preparing`:
      - `addWorktree`.
      - `sandbox.create` (worktree rw).
      - Setup commands.
      - `graphify` if provided. If `graphify-out/` isn't tracked by the repo, append `graphify-out/` once to `<commonGitDir>/info/exclude` so it is never committed.
      - → `building`.
    - Every run: call `heartbeat(db, runId, pid)` on `onPid` and every 15 s until exec resolves.
    - `building`:
      - done → `commitAll` → `verifying`, patching `head_sha`.
      - needs_human → `blocked`, with `blocked_reason` = the question.
      - rate_limited → leave the state alone, set a pause until `resetAt` or +30 min, don't count an attempt.
      - error/timeout → `attempt+1`. Stay in `building`, or go to `blocked` when `attempt >= max_attempts`.
    - `verifying`: run each check in the sandbox. Any non-zero result goes to `building` with the tail of that check's log as `failureTail` (stored in the run result) and `attempt+1`. Otherwise → `reviewing`.
    - `reviewing`: `diff(base_sha, head_sha)` → review agent. Any blocking finding → `building` with `attempt+1`. Otherwise → `awaiting_approval`, with the findings in the run result.
  - A pause is held in memory, in `pausedUntil`, and logged as an event of type `note`.

- [ ] **Step 1:** Write the tests, driving `step` until it returns `idle`.
  - `happy path reaches awaiting_approval`. The branch `sf/T-1` has one commit, and the run kinds in order are build, verify, review.
  - `check fails 3x → blocked`, with `blocked_from='building'`.
  - `needs_human → blocked`, with the question as `blocked_reason`.
  - `rate_limited does not count attempt and pauses`. `step` returns `'paused'`, and after the clock passes +30 min it builds again.
  - `blocking review finding → building`.
  - `ticket body is passed on stdin`. The FakeSandbox records the stdin containing the body.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: supervisor pipeline to approval`.

### Task 9: Human actions, integration, recovery

**Files:**
- Create: `src/actions.ts`
- Modify: `src/supervisor.ts` (integrating stage + `recover`), `src/cli.ts` (action commands)
- Test: `src/actions.test.ts`, `src/supervisor.test.ts` (add cases)

**Interfaces:**
- Produces, in `actions.ts` (used by the CLI and the server; every action goes through `transition` with `actor:'human'`):
  - `approve(db, id)`: `awaiting_approval → integrating`, event `approval` with `data: { headSha }`.
  - `reject(db, id, note)`: `→ ready`, `attempt: 0`, `human_note: note`.
  - `answer(db, id, text)`: `blocked → ready`, `attempt: 0`, `human_note: text`.
  - `retry(db, id)`: `blocked → blocked_from`, `attempt: 0`.
  - `reset(db, id)`: `blocked → ready`. Clears `worktree_path`/`base_sha`/`head_sha` after removing the worktree and sandbox.
  - `cancel(db, id)`: kills the active run if it belongs to this ticket, then `→ cancelled`, then cleanup.
- Supervisor additions:
  - Stage `integrating`:
    1. Require an `approval` event whose `headSha` equals the ticket's `head_sha`; otherwise `blocked` with "approval stale".
    2. `mergeTree`. A conflict → `blocked`.
    3. `squashCommit`.
    4. If the target tip ≠ `base_sha`: `addDetachedWorktree` at the squash sha, then run setup and checks in a fresh sandbox. Failure → `blocked`.
    5. `advanceTarget`: `'dirty'` or `'moved'` → `blocked` with that reason.
    6. → `done`. Remove the worktree and sandbox.
  - `recover(db, isAlive: (pid: number) => boolean)`: every `starting|running` run with a dead or missing pid becomes `lost`. The next build prompt for that ticket gets `partialWork:true`.
- CLI: `sf approve|reject --note|answer --text|retry|reset|cancel <id>`.

- [ ] **Step 1:** Write the tests.
  - `approve then integrate advances target with one squash commit`.
  - `approval for old head_sha is rejected`: approve, then patch `head_sha`, then `blocked`.
  - `target moved and recheck passes → done`.
  - `target moved and recheck fails → blocked`.
  - `conflict → blocked`.
  - `reject resets attempt and stores note`.
  - `recover marks dead-pid run lost and step redispatches with partialWork`.
  - `cancel during build kills run` (FakeSandbox exec that never resolves until killed).
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: approvals, squash integration, crash recovery`.

### Task 10: `sf serve` — HTTP API, SSE, single-instance lock

**Files:**
- Create: `src/server.ts`
- Modify: `src/cli.ts` (`sf serve [--port 4400]`)
- Test: `src/server.test.ts`

**Interfaces:**
- Consumes: store, actions, `git.diff`, `supervisor.step/recover`.
- Produces:
  - `createServer(db, opts: { port: number; webDist: string }): http.Server`, bound to `127.0.0.1`.
  - `acquireLock(path): () => void`. Writes the pid to `serve.lock`. If an existing lock holds a live pid it throws `sf serve already running (pid N)`; a stale lock is replaced.
  - Routes:
    - `GET /api/tickets`
    - `GET /api/tickets/:id` → `{ ticket, runs, events, diff? }`
    - `GET /api/runs/:id/log?offset=n` → `{ text, offset }`
    - `GET /api/events` (SSE: polls `eventsSince` every 1 s)
    - `POST /api/tickets/:id/{approve|reject|answer|retry|reset|cancel}` with JSON body `{note?|text?}`
    - Static files from `webDist` with an SPA fallback.
  - `sf serve`: acquire the lock → `recover` → listen → loop `step` (2 s sleep when idle).
    - Real deps: `new SbxSandbox()`.
    - `graphify` = `execFile('graphify', ['update', wt])` when `graphify` is on PATH; otherwise omitted, with a startup warning.

- [ ] **Step 1:** Write the tests.
  - `POST without application/json → 415`.
  - `POST with foreign Origin → 403`.
  - `POST approve with good Origin → 200 and state integrating`.
  - `second acquireLock with live pid throws`.
  - `stale lock replaced`.
  - `unknown ticket id → 404; malformed id → 400`.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: sf serve with local API and lock`.

### Task 11: Dashboard

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/Board.tsx`, `web/src/Ticket.tsx`, `web/src/api.ts`, `web/src/index.css`

**Interfaces:**
- Consumes: the Task 10 routes.
- Produces:
  - **Board:** a column per state group: Spec (`new`, `specifying`, `specified`), Ready, In progress (`preparing`, `building`, `verifying`, `reviewing`), Needs you (`awaiting_approval`, `blocked`), Integrating/Done. It refreshes on SSE.
  - **Ticket page:**
    - spec (rendered as plain text in `<pre>`, no HTML injection)
    - diff in `<pre>` with +/- line colouring
    - check results
    - review findings by severity
    - live log tail
    - event timeline
    - buttons valid for the current state: Approve, Reject (requires a note), Answer, Retry, Reset, Cancel
  - Vite dev proxy `/api → http://127.0.0.1:4400`. The build outputs to `web/dist`.

- [ ] **Step 1:** Install the dev dependencies listed in Global Constraints. Scaffold Vite + React + Tailwind v4 (`@tailwindcss/vite`, `@import "tailwindcss"`).
- [ ] **Step 2:** Implement the board and ticket page. Use no `dangerouslySetInnerHTML` anywhere.
- [ ] **Step 3:** Run `npm run build:web && npm run typecheck`. Expected: build succeeds, no type errors.
- [ ] **Step 4:** Manual check: `sf serve` with seeded tickets. Expected: the board shows them; Approve on an `awaiting_approval` ticket moves it; Reject without a note is disabled.
- [ ] **Step 5:** Commit `feat: dashboard`.

### Task 12: `sf doctor`, `/sf` skill, README

**Files:**
- Create: `src/doctor.ts`, `skill/SKILL.md`, `README.md`
- Modify: `src/cli.ts`
- Test: `src/doctor.test.ts`

**Interfaces:**
- Produces:
  - `checkTools(): Promise<{ name: string; ok: boolean; detail: string }[]>` for `git`, `sbx`, `claude`, `uv`, `graphify` (graphify optional = warn).
  - `findOrphans(db, worktreeDirs: string[], sandboxNames: string[]): { worktrees: string[]; sandboxes: string[] }`. An orphan has no ticket in a non-terminal state.
  - `sf doctor [--fix]`.
- `SKILL.md`: when the user wants to work with the factory, call `sf`. Never run approve, reject or answer without the user's explicit choice. Show `repo add` profiles for confirmation. Point to the dashboard URL.

- [ ] **Step 1:** Write the test `findOrphans flags worktree and sandbox of done ticket, keeps active ones`. **Step 2:** Run: FAIL. **Step 3:** Implement. **Step 4:** Run: PASS.
- [ ] **Step 5:** Write the README: install, `sf doctor`, the spike-notes auth setup, the flow, safety model in five lines.
- [ ] **Step 6:** Commit `feat: doctor, claude code skill, readme`.

### Task 13: End-to-end on real repos

**Files:**
- Create: `scripts/make-samples.mjs`. It creates `SF_HOME/../samples/sample-ts` (npm, a `test` script using `node --test`, `typecheck`) and `sample-py` (uv, pytest, ruff), each a git repo with one commit on `main`.
- Create: `docs/manual-check.md`

- [ ] **Step 1:** Run `node scripts/make-samples.mjs`, then `sf repo add` on both repos.
- [ ] **Step 2:** For each repo, run the ticket "add a `slugify(s)` function with tests" through `sf spec --agent` → `sf ready`, with `sf serve` running.
  Expected: it reaches `awaiting_approval` with green checks, and the target branch is unchanged.
- [ ] **Step 3:** Approve in the dashboard. Expected: `git log main` shows one `T-n: …` commit with the `Factory-Ticket` trailer. The worktree and sandbox are gone (`sbx ls`).
- [ ] **Step 4:** Kill `sf serve` mid-build, then restart it. Expected: the run is `lost`, the build re-dispatches, and the ticket completes.
- [ ] **Step 5:** Write `docs/manual-check.md` with these steps and the observed results. Run `npm test && npm run typecheck`: all pass.
- [ ] **Step 6:** Run `graphify update .`. Commit `test: end-to-end manual check on ts and python repos`.

---

**Day mapping:** Day 1 = Tasks 0–5 · Day 2 = Tasks 6–9 · Day 3 = Tasks 10–13.
