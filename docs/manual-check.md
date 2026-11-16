# End-to-end manual check (Task 13), 2026-11-16

Host: Windows 11, Node 24.19.0, git 2.55, sbx v0.51.0, uv 0.12.3. Template `sf-claude-node24`.
Everything ran in an isolated home: `SF_HOME=C:\Users\abhij\.sf-e2e`, samples in `C:\Users\abhij\.sf-e2e-samples`.

## Steps

```sh
SF_HOME=C:\Users\abhij\.sf-e2e node scripts/make-samples.mjs     # -> <SF_HOME>-samples/sample-ts, sample-py
sf repo add <samples>/sample-ts          # ts: setup npm ci; checks typecheck, test
sf repo add <samples>/sample-py          # py: setup uv sync; checks ruff, pytest
sf ticket add sample-ts --title "add a slugify(s) function with tests" --body "..."   # T-1
sf ticket add sample-py --title "add a slugify(s) function with tests" --body "..."   # T-2
sf spec T-1 --agent; sf spec T-2 --agent
sf serve --port 4410                      # background
sf ready T-1; sf ready T-2                # once each is `specified`
POST /api/tickets/<id>/approve            # what the dashboard's Approve button sends
```

Step 4 (crash recovery): `taskkill /T /F` the serve process tree during a build run, check `sbx ls`, restart serve.

Ticket bodies: T-1 asks for `slugify(s: string)` in `src/slugify.ts` with node:test tests. T-2 asks for `slugify(s: str)` in `sample_py/slugify.py` with pytest tests. T-3 (sample-ts, used for step 4) asks for `truncate(s, n)` with tests.

## Defects found and fixed

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Both spec runs blocked at once: `infra: sbx create failed (1): error: primary workspace must be read/write (remove ':ro' or ':readonly')` | sbx v0.51 refuses a `:ro` first (primary) workspace. Spec and review sandboxes mounted their worktree `:ro`. Unit tests used `FakeSandbox`, which accepted any mounts. | Spec mounts its throwaway checkout rw. Review now gets its own throwaway detached checkout of the head (`<SF_HOME>/worktrees/<repo>/<id>-review`), mounted rw and removed afterwards, so the build worktree stays untouched. `buildSbxCreateArgs` and `FakeSandbox.create` reject a `:ro` first mount. `cancel`/`reset` cleanup also removes the `-review` worktree. Commit `60996f8`. Recovered with `sf retry T-1` / `sf retry T-2` (back to `specifying`). |
| 2 | Both tickets blocked in `preparing`. T-1: `infra: setup \`npm ci\` exited 255`, with `EPERM: operation not permitted, symlink '../typescript/bin/tsc' -> …/node_modules/.bin/tsc`. T-2: `infra: setup \`uv sync\` exited 2`, with `failed to symlink file … .venv/bin/python … Operation not permitted`. | On a Windows host the sandbox workspace is a virtiofs mount of an NTFS folder. Without Developer Mode, Windows refuses symlink creation, and npm and uv both need symlinks. The spike only checked that edits were visible, not that setup could run. | `SbxSandbox.exec` first runs `src/sandbox-prep.py` as root (`sbx exec -u root <name> python3 -c …`). It bind-mounts sandbox-local dirs (`/home/agent/.sf-deps/node_modules`, `.venv`) over the workspace's `node_modules` and `.venv`. This runs before every exec because sbx stops idle sandboxes, and a restart drops the bind mounts; the dirs themselves persist. The host sees only empty dirs, so dependencies never land in the worktree or the commit. A prep failure returns exit 125, which the supervisor retries once and then blocks as infra. Commit `75c8342`. Recovered with `sf retry T-1` / `sf retry T-2` (back to `preparing`). |
| 3 | (Found while testing fix 2, before it hit a ticket.) `uv run ruff check .` failed in the sandbox with `EXE002 The file is executable but no shebang is present` on every `.py` file, although it passes on the host. | The same virtiofs mount reports every file as mode 0777. ruff 0.17's default rules include EXE002. | `sandbox-prep.py` also clears the exec bits on workspace files that have no `#!` shebang (`chmod` works on the mount). This happens before every exec, so files the worker creates are covered too. The host's git ignores modes (`core.fileMode=false`), so commits are unaffected. Same commit `75c8342`. |

## Observed results

All times are local (IST). Run times come from the `runs` table.

### Steps 1–3: spec → ready → awaiting_approval → approve → done

| Ticket | Spec run | Build | Verify (Gate A) | Review | Integrate | Attempts |
|---|---|---|---|---|---|---|
| T-1 sample-ts | 51 s | 30 s | 20 s (typecheck, test) | 20 s, 0 blocking findings | 4 s | 1 (attempt stayed 0) |
| T-2 sample-py | 23 s | 31 s | 11 s (ruff, pytest) | 26 s, 0 blocking findings | 4 s | 1 (attempt stayed 0) |

The times above are for the runs after the fixes. Before them, each ticket was blocked once as infra, by defect 1 and then by defect 2. Those blocks happen outside runs and do not count as attempts.

- Both specs were complete and testable: context, approach, about ten concrete acceptance cases, files, and verification steps.
- At `awaiting_approval`, `main` was unchanged in both repos (`55f91f3` and `a3bd5c1`). Each `sf/T-n` branch held exactly one commit, `T-n: add a slugify(s) function with tests (attempt 1)`, touching only the two new files.
- Approval was `POST /api/tickets/T-n/approve` with `Origin: http://127.0.0.1:4410`, which returned 200. Both reached `done` within about 25 s.
- `sbx ls` showed `No sandboxes found`, `<SF_HOME>/worktrees/<repo>/` was empty, `git worktree list` listed only the main checkout, and `sf doctor` reported `no orphans`.

`git log main` (sample-ts, after T-1 and T-3):

```
b7ff8c0 T-3: add a truncate(s, n) function with tests
Factory-Ticket: T-3

9592e6b T-1: add a slugify(s) function with tests
Factory-Ticket: T-1

55f91f3 initial commit
```

`git log main` (sample-py):

```
ae8c74f T-2: add a slugify(s) function with tests
Factory-Ticket: T-2

a3bd5c1 initial commit
```

The author on all squash commits is `sf e2e <sf-e2e@localhost>`, the repo's local git identity. The `sf/T-n` branches are kept, as designed.

### Step 4: kill `sf serve` mid-build (T-3, sample-ts)

- Build run 12 started at 07:07:54. At 07:08:23 I ran `taskkill /T /F` on the serve process tree. It killed serve, the `sbx exec` client, and the claude process inside the sandbox (`ps` in the sandbox showed no `claude -p` afterwards).
- After the kill, `sbx ls` showed `sf-sample-ts-T-3` still running, and the worktree held uncommitted partial work (`src/truncate.ts`, `src/truncate.test.ts`). `serve.lock` held the dead pid.
- After the restart, the stale lock was taken over and `recover()` marked run 12 `lost` (pid 35084 dead). The supervisor re-dispatched the build as run 13 at 07:08:45, and its prompt carried the partial-work note. The agent's first message was "Partial work exists; let me review it.", and the build finished in 27 s.
- Verify took 15 s and review 28 s. After approval, `done` and squash `b7ff8c0` followed. A `lost` run does not count as an attempt, so the attempt stayed 0. Afterwards there were no sandboxes and no worktrees.

### Step 5

`npm test` and `npm run typecheck` both pass (see the commit `test: end-to-end manual check on ts and python repos`).

## Notes and residual concerns

- The reviewer cannot run `npm run typecheck` in its throwaway checkout because dependencies are not installed there. The T-1 reviewer said so in its summary. Gate A had already run every check on the same head, so this is informational only.
- The T-2 spec agent noted "git worktree metadata in this checkout is broken (points at a Windows path)". This is expected, because git is host-only by design.
- `sandbox-prep.py` walks the whole workspace on every exec (marked as a shortcut in the code). It is fine for these repos but could be slow on very large ones.
- The fixes for defects 2 and 3 are tied to the Windows host. On a Linux or macOS host the bind mount is harmless, and the chmod only touches files that are executable and have no shebang.
- Killing serve with `taskkill /F` skips its exit handler, so the stale `serve.lock` is reclaimed on the next start, as observed.
