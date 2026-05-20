---
title: "Runner Recovery Sweeper For Interrupted Handoff"
created_at: "2026-05-20T20:58:00+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-05-20/2035-runner-recovery-sweeper.md"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/774"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Implement runner-owned recovery for interrupted scoped issue handoff so completed local runs like #773 can safely finish draft PR publication or block with evidence without rerunning child Codex.
- **Source Material:** Plan `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-05-20/2035-runner-recovery-sweeper.md`; issue `https://github.com/SergiiMytakii/codex-orchestrator/issues/774`.
- **Approved Scope:** Scoped issue recovery only: runner-state metadata, recovery classification, PR lookup by head/base, reusable scoped publication helpers, targeted `run --issue` recovery, daemon startup/tick sweeper, status reporting, short deep-dive docs update, and automated tests. Legacy #773 may be recovered only through explicit targeted recovery when local snapshot base evidence is present.
- **Out of Scope:** No child Codex rerun for recovery; no plan-parent/tree-child handoff recovery; no auto-merge; no broad mutation of `agent:running` issues without matching local metadata; no release/npm publish flow changes; no package live-smoke suite by default.
- **Simplest Viable Path:** Add one scoped recovery use case that reuses the existing runner-owned publishability and shared scoped handoff behavior, then call it from status, daemon, and targeted run paths.
- **Primary Risk:** Publishing or blocking a run that is still active, foreign, or lacks deterministic base evidence.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** No secrets. Local tests use fake adapters/temp repos. Live #773 recovery needs authenticated `gh` and the existing local #773 worktree/report/snapshot, but live recovery is a final manual gate after local tests pass.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `src/runner/local-state.ts`; `src/runner/context-snapshot.ts`; `src/runner/recovery.ts`; new `src/runner/scoped-recovery.ts`; `src/runner/scoped-auto-command.ts`; `src/runner/daemon-command.ts`; `src/runner/status-command.ts`; `src/cli.ts`; `src/github/pull-requests.ts`; `src/github/gh-pull-request-adapter.ts`; `docs/deep-dive.md`; `test/local-state.test.ts`; `test/recovery.test.ts`; `test/status-command.test.ts`; `test/daemon-command.test.ts`; `test/scoped-auto-command.test.ts`; `test/pull-request-adapter.test.ts`; new `test/scoped-recovery.test.ts`.
- **Confirmed Commands:** `npm run typecheck`; `npm test`; final live recovery smoke after local validation: `npm run build --silent && node dist/src/cli.js run --target . --issue 773` when #773 fixture still exists. Do not run `npm run smoke:live` unless separately requested at implementation time.
- **Protected Paths / Rejected Approaches:** Never read/edit `.env` or `.env.*`. Do not mutate `.codex-orchestrator/workspaces/issue-773` during automated unit tests. Do not add a second publication implementation. Do not add a new scheduler or external service. Do not change label vocabulary.
- **Architecture Lens:** Reuse scoped runner handoff as the deep module. New `scoped-recovery.ts` is allowed because deletion would otherwise scatter interrupted-run classification/recovery across daemon, status, and CLI. It must expose a small use-case interface and delegate publication to shared scoped handoff helpers. No new GitHub adapter abstraction.

## 3. Deterministic Recovery Contracts
- **Lease Constants:** Add `SCOPED_RECOVERY_LEASE_STALE_MS = 30 * 60 * 1000` in `src/runner/scoped-recovery.ts` and export it only if tests need it. Use injected `now: Date` for tests and `new Date()` in production. A lease timestamp is stale when `now.getTime() - Date.parse(run.leaseUpdatedAt) >= SCOPED_RECOVERY_LEASE_STALE_MS`. Missing, invalid, or future `leaseUpdatedAt` is not stale.
- **Host/PID Rule:** Store `host` from `node:os.hostname()` and `ownerPid` from `process.pid`. In recovery, if `run.host === hostname()` and `ownerPid` is an integer, call a local `processProbe(pid)` that returns `alive`, `missing`, or `unknown`. Implementation default uses `process.kill(pid, 0)`: success or `EPERM` => `alive`; `ESRCH` => `missing`; any other error => `unknown`. Same-host `alive` or `unknown` never mutates. Cross-host daemon recovery never mutates. Cross-host targeted recovery may mutate only when lease is stale and every other ownership/base/report check passes.
- **Base Evidence:** Resolve `beforeHead` in this order: `run.baseSha`; JSON at `run.snapshotPath` field `repository.base.sha`; legacy JSON at `${targetRoot}/${config.runner.stateDir}/snapshots/issue-${run.issueNumber}-${run.sessionId}.json` field `repository.base.sha`. The value must be a non-empty string; if absent, recovery is read-only `unknown-or-foreign`.
- **Report State:** Use `readScopedCompletionReport(run.reportPath)`. `completed` means result kind is `valid` and `report.status === "completed"`. `needs-promotion`, `missing`, or parse/validation errors are not publishable; they may become `failed-pending-block` only for stale lease-proven runs.
- **Recovered Codex Result:** When and only when the stored report is parsed as completed, pass exactly `{ stdout: `codex-orchestrator recovery reused completed report ${run.reportPath}`, stderr: '', exitCode: 0 }` to `runImplementationPublishabilityCheck`. This does not bypass gates because the function still reads `reportPath`, validates changed paths/safety, runs configured checks/proof, and can block. Do not call Codex CLI in recovery.
- **Blocked Dedupe Marker:** Use one GitHub-comment marker only: `<!-- codex-orchestrator:recovery-blocked issue=<issueNumber> session=<sessionId> -->`. Before posting a recovery blocked comment, scan existing issue comments for this exact marker. If present, do not post another blocked comment; still update `lastRecoveredAt`. Do not use lifecycle events as the dedupe source.

## Recovery Decision Table
| Invocation | Metadata/Ownership | Report | Base Evidence | Lease/Process | Outcome | Allowed Mutation |
|------------|--------------------|--------|---------------|---------------|---------|------------------|
| `status` | any local run | any | any | any | classify only | none |
| `daemon` | incomplete, non-scoped, mismatched issue, missing branch/worktree/report path | any | any | any | `unknown-or-foreign` | none |
| `daemon` | complete scoped metadata | completed | present | same-host alive/unknown, lease fresh, cross-host, or legacy no lease | `active` or `unknown-or-foreign` with reason | none |
| `daemon` | complete scoped metadata | completed | present | same-host missing PID and stale lease | `completed-pending-handoff` | shared review-ready handoff only |
| `daemon` | complete scoped metadata | missing/invalid/needs-promotion | present | same-host missing PID and stale lease | `failed-pending-block` | blocked report with dedupe marker |
| `run --issue` | incomplete, non-scoped, mismatched issue | any | any | any | normal not-eligible/error path | none |
| `run --issue` | complete scoped metadata | completed | present | legacy no lease, or stale lease; same-host alive/unknown remains active | `completed-pending-handoff` | shared review-ready handoff only |
| `run --issue` | complete scoped metadata | missing/invalid/needs-promotion | present | stale lease only; legacy no lease remains unknown | `failed-pending-block` | blocked report with dedupe marker |
| any mutating path | complete scoped metadata | any | absent | any | `unknown-or-foreign` | none |

## Contract Test Ledger
| Invariant | Owner | First RED Test/Proof | Green Contract |
|-----------|-------|----------------------|----------------|
| New scoped runs persist deterministic recovery evidence and legacy state still loads | `RunnerStateStore` / `runScopedAutoCommand` | `test/local-state.test.ts` adds `local state accepts recovery lease/base metadata and preserves legacy metadata` | New optional fields validate strictly, forbidden-key validation stays, old metadata loads |
| Running scoped issue with completed report and stale/proven ownership classifies as `completed-pending-handoff` | `src/runner/scoped-recovery.ts` | `test/scoped-recovery.test.ts` adds `classifies stale completed scoped run as completed-pending-handoff` | Status/recovery exposes recoverable state without mutation |
| Daemon auto-recovery never publishes legacy/no-lease or cross-host runs | `src/runner/scoped-recovery.ts` | `test/scoped-recovery.test.ts` adds `daemon leaves legacy and cross-host completed runs read-only` | Daemon mutates only same-host stale missing-PID runs |
| Targeted `run --issue` can recover already-running scoped issue before CLI eligibility rejection | `src/cli.ts` / scoped recovery use case | `test/scoped-recovery.test.ts` adds `targeted recovery accepts already-running legacy snapshot-backed completed run` | Targeted recovery finishes or blocks with evidence without rerunning Codex |
| Existing open/draft PR by branch/base is reused, not duplicated | `GitHubPullRequestAdapter` / shared handoff helper | `test/pull-request-adapter.test.ts` adds `finds open pull request by head and base` | Recovery verifies refs and completes labels/comments/state cleanup without creating another PR |
| Publication path remains runner-owned and shared | `src/runner/scoped-auto-command.ts` extracted helper | `test/scoped-auto-command.test.ts` existing review-ready handoff test must pass unchanged after extraction | Normal scoped execution and recovery use the same helper for review-ready handoff |
| Unsafe evidence does not publish | scoped recovery use case | `test/scoped-recovery.test.ts` adds `does not publish when base evidence is missing` | Unsafe states are read-only or stale-proven blocked with concrete report |
| Recovery-blocked path is idempotent | scoped recovery use case / GitHub comments | `test/scoped-recovery.test.ts` adds `recovery blocked comment uses stable marker and is not duplicated` | Metadata retained with `lastRecoveredAt`; duplicate blocked comments prevented by the exact marker |
| Lease policy is deterministic | scoped recovery use case | `test/scoped-recovery.test.ts` adds `lease policy distinguishes fresh alive missing unknown and cross-host cases` | Uses 30-minute threshold, injected clock, and deterministic processProbe outcomes |
| Recovered publishability uses exact synthetic Codex result | scoped recovery use case | `test/scoped-recovery.test.ts` adds `recovery passes completed-report codex result without invoking codex` | `runImplementationPublishabilityCheck` receives the exact stdout/stderr/exitCode shape and still reads the report |

## Risk Controls
- **Source of Truth:** `RunnerStateStore` plus context snapshot are the only local ownership evidence. `runImplementationPublishabilityCheck` remains the source of truth for safe publishability. Shared scoped handoff helper remains the only source for draft PR/review label/comment publication.
- **Safety Constraints:** Recovery may mutate GitHub only for `mode: "scoped-issue"`, open issue with configured `agent:running`, matching issue number, matching branch/worktree/report metadata, deterministic `beforeHead`, and a mutating row in the Recovery Decision Table.
- **Contract Constraints:** `GitHubPullRequestAdapter` must gain `findOpenPullRequestByHeadAndBase(headBranch, baseBranch)`. `RunnerProcessMetadata` remains version 1 and backwards-compatible with existing state files.
- **Concurrency / State Constraints:** Review-ready recovery removes run metadata. Blocked recovery preserves run metadata with `lastRecoveredAt` and the exact blocked marker. Recovery does not count toward daemon `--max-runs`.
- **Forbidden Scope:** No foreign/manual recovery, no duplicate PRs, no Codex rerun, no automatic legacy daemon recovery, no plan/tree recovery, no package `npm run smoke:live` by default.

## Write Scope Summary
- `src/runner/local-state.ts` - Update metadata type/validation for lease and deterministic evidence; keep legacy reads valid.
- `src/runner/context-snapshot.ts` - No schema-breaking changes; only read existing snapshot evidence if helper placement requires it.
- `src/runner/recovery.ts` - Preserve existing clarification recovery behavior; either extend entries to include scoped statuses or delegate scoped-specific classification to `scoped-recovery.ts`.
- `src/runner/scoped-recovery.ts` - Create scoped recovery classifier/use case, lease policy, base resolution, process probe, and blocked marker handling.
- `src/runner/scoped-auto-command.ts` - Extract shared review-ready and blocked handoff helpers; update new run state with lease/base/snapshot metadata; preserve current behavior.
- `src/runner/daemon-command.ts` - Run recovery sweeper before issue selection on each loop; log outcomes; keep `executed` as newly selected issues only.
- `src/runner/status-command.ts` - Surface richer recovery entries read-only.
- `src/cli.ts` - Route already-running scoped issues with matching recoverable local metadata to targeted recovery before throwing normal eligibility errors.
- `src/github/pull-requests.ts` - Add adapter method and in-memory behavior for open/draft PR lookup by head/base.
- `src/github/gh-pull-request-adapter.ts` - Implement lookup with `gh pr list --state open --head <branch> --base <base> --json number,url,isDraft,headRefName,baseRefName --limit 1`.
- `docs/deep-dive.md` - Add short recovery safety/routing note.
- Tests: exact files named in the Contract Test Ledger.

## 4. Execution Slices
### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice.
- [x] Start each behavior-changing slice with the named RED test/proof.
- [x] Update the Contract Test Ledger status as invariants move planned -> red -> green or blocked.

### Slice 1 - Persist Recovery Evidence For New Scoped Runs
- [x] Objective: Future scoped runs record deterministic evidence while legacy state remains readable.
- [x] Test/Proof First: Add `test/local-state.test.ts` test `local state accepts recovery lease/base metadata and preserves legacy metadata`.
- [x] Target: `src/runner/local-state.ts`
  - [x] Action: Extend `RunnerProcessMetadata` and `runKeys` with optional `ownerPid`, `host`, `leaseUpdatedAt`, `attemptStartedAt`, `baseSha`, `snapshotPath`; validate `ownerPid` integer and all other new fields as non-empty strings when present.
  - [x] Validation: `npm run build --silent && node --test dist/test/local-state.test.js`.
- [x] Target: `src/runner/scoped-auto-command.ts`
  - [x] Action: Add `host`, `ownerPid`, `attemptStartedAt`, refreshed `leaseUpdatedAt`, `baseSha: resolvedBase.sha`, and `snapshotPath` to `store.upsertRun` after `writeContextSnapshot` returns.
  - [x] Validation: existing `test/scoped-auto-command.test.ts` review-ready handoff test still removes run metadata after successful handoff.

### Slice 2 - Classify Scoped Interrupted Runs Read-Only
- [x] Objective: Status distinguishes active, recoverable, blocked-pending, and unknown scoped runs without mutating GitHub.
- [x] Test/Proof First: Add `test/scoped-recovery.test.ts` tests named in Contract Test Ledger for classification, lease policy, and base evidence.
- [x] Target: `src/runner/scoped-recovery.ts`
  - [x] Action: Implement classification per Recovery Decision Table, including exact lease constants, process probe, base evidence resolution, report state parsing, and mutation eligibility.
  - [x] Validation: `npm run build --silent && node --test dist/test/scoped-recovery.test.js`.
- [x] Target: `src/runner/recovery.ts` and `src/runner/status-command.ts`
  - [x] Action: Surface scoped statuses in `RecoveryEntry` while preserving existing missing/completed/clarification statuses for non-running or blocked issues.
  - [x] Validation: `test/status-command.test.ts` expects `completed-pending-handoff` instead of plain `active` for a read-only recoverable fixture.

### Slice 3 - Add Idempotent PR Lookup Contract
- [x] Objective: Recovery detects an already-created open/draft PR by branch/base and avoids duplicates.
- [x] Test/Proof First: Add `test/pull-request-adapter.test.ts` test `finds open pull request by head and base`.
- [x] Target: `src/github/pull-requests.ts`
  - [x] Action: Add `findOpenPullRequestByHeadAndBase(headBranch, baseBranch)` to the interface and in-memory implementation.
  - [x] Validation: test covers match, no match, wrong base.
- [x] Target: `src/github/gh-pull-request-adapter.ts`
  - [x] Action: Implement the exact `gh pr list` command from Write Scope Summary and parse empty array as undefined.
  - [x] Validation: adapter command-shape test asserts args and JSON parsing.

### Slice 4 - Share Scoped Handoff Without Behavior Change
- [x] Objective: Normal scoped execution and recovery use one publication implementation.
- [x] Test/Proof First: Run `npm run build --silent && node --test dist/test/scoped-auto-command.test.js` before and after extraction.
- [x] Target: `src/runner/scoped-auto-command.ts`
  - [x] Action: Extract shared review-ready handoff helper and blocked handoff helper that accept already-computed publishability/fresh review/durable summary inputs. Keep `runScopedAutoCommand` public result and failure-after-PR semantics unchanged.
  - [x] Validation: existing scoped command tests pass unchanged.

### Slice 5 - Recover Completed Pending Handoff
- [x] Objective: Completed local scoped run finishes draft PR handoff without rerunning Codex.
- [x] Test/Proof First: Add `test/scoped-recovery.test.ts` tests `recovers completed pending handoff by creating one draft PR` and `reuses matching open PR during recovery`.
- [x] Target: `src/runner/scoped-recovery.ts`
  - [x] Action: Implement mutating recovery for `completed-pending-handoff`: load issue/run, resolve `beforeHead`, get `afterHead`, build exact recovered `codexResult`, call `runImplementationPublishabilityCheck`, run Fresh-Context Review if enabled, find/reuse matching open PR or create one through shared handoff, transition labels, post review report, append lifecycle event, remove local state.
  - [x] Validation: tests assert no Codex adapter call, exact synthetic codexResult, branch push, one PR, running->review labels, review comment, lifecycle event, and local metadata removal.

### Slice 6 - Block Stale Failed Recovery Safely
- [x] Objective: Stale runner-owned failed/missing/invalid reports block with concrete evidence and no duplicate comments.
- [x] Test/Proof First: Add `test/scoped-recovery.test.ts` test `recovery blocked comment uses stable marker and is not duplicated`.
- [x] Target: `src/runner/scoped-recovery.ts` and shared blocked helper
  - [x] Action: Implement `failed-pending-block` only for stale lease-proven rows. Prefix blocked report with the exact dedupe marker. Scan comments for marker before posting. Preserve local metadata and update `lastRecoveredAt`.
  - [x] Validation: repeated recovery posts one blocked comment and never creates PR/review label.

### Slice 7 - Wire Daemon And Targeted Run Recovery
- [x] Objective: Recovery runs before daemon issue selection and targeted `run --issue` can recover already-running scoped issues.
- [x] Test/Proof First: Add `test/daemon-command.test.ts` test `daemon runs recovery before selection without counting max-runs`; add `test/scoped-recovery.test.ts` test `targeted recovery accepts already-running legacy snapshot-backed completed run`.
- [x] Target: `src/runner/daemon-command.ts`
  - [x] Action: Run recovery sweeper at the start of each loop before `findNextEligibleIssues`; emit outcome lines; keep `executed` limited to newly selected issues.
  - [x] Validation: daemon test asserts ordering and max-runs behavior.
- [x] Target: `src/cli.ts`
  - [x] Action: Before throwing `not eligible`, call targeted recovery for already-running scoped issues when local metadata classifies as a mutating targeted row. Preserve normal errors for non-recoverable/non-scoped issues.
  - [x] Validation: targeted recovery test proves no Codex rerun and returns a normal result comment.

### Slice 8 - Documentation And Final Validation
- [x] Objective: Document recovery safety model and prove package locally.
- [x] Test/Proof First: No behavior test; docs follow implemented behavior.
- [x] Target: `docs/deep-dive.md`
  - [x] Action: Add a short section describing interrupted-handoff recovery, statuses, daemon vs targeted safety limits, no Codex rerun, no auto-merge, and package live-smoke suite exclusion.
  - [x] Validation: documentation matches Recovery Decision Table.
- [x] Target: whole repo
  - [x] Action: Run `npm run typecheck` and `npm test`.
  - [x] Validation: both pass. Targeted live recovery smoke `npm run build --silent && node dist/src/cli.js run --target . --issue 773` was not run because it mutates live GitHub state and the operator did not approve that live gate in this turn. `npm run smoke:live` was not run by default.

## 5. Validation And Done Criteria
- [x] **Lint/Format:** Not applicable; no dedicated lint script is configured in `package.json`; `git diff --check` passed.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** `npm test`.
- [x] **Architecture Check:** No dedicated architecture-check script; applied repo quality preflight from `docs/agents/execution-routing.md` and ran `$cleanup-review` then `$code-review` after implementation because this is a medium/large runtime change.
- [x] **Live/Manual Validation:** Targeted live recovery smoke for #773 after local validation if fixture still exists and operator approval is present; package `npm run smoke:live` is not a default gate.
  - Ran `npm run build --silent` and `node dist/src/cli.js run --target . --issue 773` after operator approval. Recovery completed through the blocked handoff path, posted the stable `codex-orchestrator:recovery-blocked` marker on #773, and left #773 open with `agent:blocked` because configured check `codex-orchestrator visual-proof mobile --issue 773` failed with `Unknown command: visual-proof`.
- [x] **Behavior Proof:** Automated fake-adapter tests prove recovery classification, completed handoff, blocked stale handling, daemon ordering, targeted run routing, idempotent PR lookup, exact synthetic codexResult, deterministic lease policy, Fresh-Context Review blocking, repeated blocked-marker local-state-only behavior, and local state cleanup.
- [x] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## Halt Conditions
- [x] Stop if deterministic `beforeHead` cannot be obtained from `RunnerProcessMetadata.baseSha` or context snapshot `repository.base.sha`.
- [x] Stop if daemon recovery would mutate without same-host missing-PID stale lease proof.
- [x] Stop if recovery needs to rerun child Codex to prove safety.
- [x] Stop if handoff extraction duplicates PR/comment/label transition logic instead of sharing it.
- [x] Stop before package `npm run smoke:live`; it is outside this spec by default.

## Defect Closure Notes
- [x] First review defect fixed: deterministic lease policy now defines threshold, clock, PID outcomes, cross-host behavior, and tests.
- [x] First review defect fixed: recovered `codexResult` payload is exact and gated by parsed completed report.
- [x] First review defect fixed: blocked recovery idempotency uses one GitHub comment marker only.
- [x] First review defect fixed: Contract Test Ledger now names exact first RED tests.
- [x] First review defect fixed: spec removed the author-facing Final Action placeholder and uses implementation completion criteria instead.
- [x] Second review verdict: Approved; no remaining blockers.
- [x] Post-implementation review defect fixed: recovered completed handoff now runs Fresh-Context Review and blocks on high-confidence policy violations.
- [x] Post-implementation review defect fixed: repeated blocked-marker recovery updates only local `lastRecoveredAt` after the issue is no longer in a mutating recovery row.

## Post-Implementation Signoff Requirement
1. Implement the approved scope.
2. Update this spec checklist during implementation.
3. Reconcile all unchecked items.
4. Run `npm run typecheck` and `npm test`.
5. Run `$cleanup-review` in a dedicated subagent.
6. Integrate safe cleanup fixes and rerun relevant validation.
7. Run one final `$code-review` on the settled change set.
8. Prepare the final user-facing completion message.
