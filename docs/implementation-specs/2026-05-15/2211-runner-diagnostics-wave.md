---
title: "Runner diagnostics, lifecycle events, snapshots, and phase profiles wave"
created_at: "2026-05-15T19:11:04Z"
source_type: "wave"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/397"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/398"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/399"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/400"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/401"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/402"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/403"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/404"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 1. Execution Context
- **Goal:** Implement the diagnostics wave for #397 through child issues #398-#404: phase-specific Codex profiles, append-only lifecycle events, bounded context snapshots, read-only doctor, status JSON, docs/regression coverage, and final live smoke validation.
- **Source Material:** GitHub issues #397-#404 and local repo evidence from `AGENTS.md`, `package.json`, `src/config/schema.ts`, `src/setup/project-config.ts`, `src/codex/command-adapter.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/fresh-context-review.ts`, `src/runner/status-command.ts`, `src/runner/local-state.ts`, `src/cli.ts`, `scripts/live-smoke.mjs`, and `docs/live-smoke-checklist.md`.
- **Approved Scope:** Only the child issue requirements #398-#404. Keep GitHub Issues as the queue, Runner-owned selection/publication/validation, Agent work inside runner-prepared workspaces, and draft PR handoff as completion.
- **Out of Scope:** tmux/HUD/persistent panes, native Codex hooks, global Codex config mutation, mandatory MCP servers, Agent-selected routing/profiles/publication, auto-merge, release/deploy/npm publication, applying `agent:auto` or `agent:plan-auto` labels outside explicit live-smoke scenario setup.
- **Simplest Viable Path:** Add shared contracts in existing config/Codex/session/status owners, then integrate one vertical runner path at a time with fake adapters before live smoke.
- **Primary Risk:** Drift between profile phase names, lifecycle event artifact references, snapshots, status JSON, and live smoke assertions.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Local validation uses fake GitHub adapters, fake process executors, temp repos, and existing `test/fixtures/config.ts`. Live gate #404 requires working `gh` auth, real Codex CLI auth, and permission to create/cleanup issues, branches, and draft PRs in `SergiiMytakii/codex-orchestrator`.
- **Blocking Unknowns:** None for local implementation. For #404, if live credentials/GitHub/Codex auth fail, record the exact blocker and do not mark live smoke passed.
- **Confirmed Commands:** `npm run typecheck`; `npm test`; final #404 local preflight `npm run smoke:live -- --scenario <diagnostics-scenario> --cleanup` as needed; final live gate `npm run smoke:live -- --cleanup`.
- **Protected Paths / Rejected Approaches:** Do not change release workflow or run `npm publish`. Do not store secrets, raw Codex transcripts, full issue comment dumps, or hidden prompt/report contents in status JSON or snapshots. Do not let prompts, completion reports, or Agents select Codex profiles. Do not make doctor/status mutate GitHub, create worktrees, launch Codex, or edit project files.
- **Architecture Lens:** Reuse existing owners. `src/config/schema.ts` owns config/profile validation, `src/codex/command-adapter.ts` owns effective Codex command/env execution, runner command modules own session phase calls, `RunnerStateStore` remains active-run source of truth, and new event/snapshot modules must be deep modules with direct public interfaces. Deletion test: if a new helper only forwards to one call site without enforcing schema, redaction, ordering, or bounded evidence, remove it.

## Risk Controls
- **Source of Truth:** Phase/profile names are owned by a new exported type in `src/codex/command-adapter.ts` or `src/config/schema.ts`; all runner calls must pass one of those values instead of string literals.
- **Contract Constraints:** Lifecycle events are append-only JSONL evidence under runner state, snapshots are bounded JSON artifacts under runner state, and status/doctor JSON are public CLI contracts.
- **Safety Constraints:** Profile env can add deterministic non-secret values only. Reject or omit forbidden auth/secret keys such as `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `HOME`, and the prompt/report env names; diagnostics may list redacted env keys but not values.
- **State Constraints:** Active runs come from `RunnerStateStore`; lifecycle events are supporting evidence only. Event write/read failures must not create review-ready publication before gates pass.
- **Forbidden Scope:** No compatibility shims beyond existing config fallback, no future phase framework beyond the named phase/profile contract below, and no live GitHub/Codex calls in normal tests.

## 3. Shared Contracts
- **Phase/Profile Contract:** Use exact phase keys `plan-parent`, `scoped-issue`, `tree-child`, `fresh-context-review`, `visual-proof`, and `quality-review`. Add optional `codex.profiles?: Partial<Record<phase, { command?: string; args?: string[]; timeoutMs?: number; idleTimeoutMs?: number; env?: Record<string,string> }>>`. Effective profile = existing `codex.command/args/timeoutMs/idleTimeoutMs` plus selected profile overrides; existing `mobileTimeoutMs` behavior remains for mobile implementation issues unless the selected profile sets `timeoutMs`.
- **Lifecycle Event Schema:** JSONL file `stateDir/events/runner-events.jsonl`; event shape `{ version: 1, id: string, timestamp: string, issueNumber: number, parentIssueNumber?: number, mode: RunnerMode, sessionId?: string, phase: phase, status: "started" | "completed" | "blocked" | "failed" | "skipped", summary: string, artifacts?: Array<{ kind: "prompt" | "report" | "log" | "snapshot" | "pr" | "durable-summary" | "other", path?: string, url?: string, description?: string }> }`.
- **Context Snapshot Contract:** JSON path `stateDir/snapshots/issue-${issueNumber}-${sessionId}.json`; shape `{ version: 1, createdAt, issue:{ number,title,bodySummary,labels,commentSummaries? }, runner:{ mode,phase,decision,selectedProfile,publicationBoundaries }, repository:{ targetRoot,baseBranch,branchName,headSha? }, session:{ sessionId,worktreePath,promptPath,reportPath,logPath }, dependencies:{ parentIssueNumber?,blockedBy?,children? }, config:{ version,hash }, artifacts:{ promptPath,reportPath,logPath } }`. Bound issue body/comment summaries; do not store raw transcripts, secrets, or full comments.
- **Doctor JSON Shape:** `{ version: 1, generatedAt, repo:{ owner,name }, target, summary:{ pass:number,warn:number,fail:number }, pass: CheckResult[], warn: CheckResult[], fail: CheckResult[] }`; `CheckResult = { id:string, title:string, status:"pass"|"warn"|"fail", summary:string, details?: string[] }`.
- **Status JSON Shape:** `{ version: 1, generatedAt, repo:{ owner,name }, target, dryRun:boolean, eligible:[], skipped:[], recovery:[], activeRuns:[], recentEvents:[] }`; preserve current text output unless `--json` is passed. Recent events are capped at 20, newest-first, and include artifact references but never raw transcripts, secrets, prompt text, or full issue comments.

## Write Scope Summary
- `src/config/schema.ts` - update types/validation for profile config and phase keys.
- `src/setup/project-config.ts` - preserve existing configs and write safe default profile-capable config for new setup.
- `src/codex/command-adapter.ts` - resolve effective phase profile, env merge/redaction, arg rendering, timeout/idle timeout.
- `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/fresh-context-review.ts` - pass phase keys, create snapshots before Codex, emit lifecycle events around claim, Codex start, report read, checks/review gates, blocked/review-ready outcomes.
- `src/runner/lifecycle-events.ts` - new append/read/cap module for JSONL events.
- `src/runner/context-snapshot.ts` - new bounded snapshot writer/validator.
- `src/runner/doctor-command.ts`, `src/runner/status-command.ts`, `src/cli.ts`, `src/index.ts` - add doctor and status JSON public surfaces.
- `test/*.test.ts`, `test/fixtures/*` - focused fake-adapter tests and one combined diagnostics regression.
- `README.md`, `CHANGELOG.md`, `docs/live-smoke-checklist.md`, `scripts/live-smoke.mjs` - operator docs, release notes, and live smoke coverage.

## 4. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Start each behavior-changing slice with the named behavior test/proof before implementation.
- [ ] Run `$tdd` for each behavior-changing child issue before coding that slice.

### Slice 1 - #398 Phase Profiles
- [ ] Objective: Existing configs still work, new optional profiles validate, and runner-owned phase selection reaches Codex execution.
- [ ] Test/Proof First: Add failing tests in `test/config-schema.test.ts`, `test/setup-command.test.ts`, and `test/codex-command-adapter.test.ts` for default fallback, partial profile override, invalid profile rejection, deterministic phase selection, timeout/idle fallback, and forbidden env redaction.
- [ ] Targets: `src/config/schema.ts`, `src/setup/project-config.ts`, `src/codex/command-adapter.ts`, `test/fixtures/config.ts`.
- [ ] Exit Gate: Focused tests pass and existing `status command preserves default behavior for configs without local commit policy` still proves backward compatibility.

### Slice 2 - #399 Lifecycle Events
- [ ] Objective: Runner writes append-only structured events for representative scoped-run phases without publishing review-ready before gates pass.
- [ ] Test/Proof First: Add failing event-store tests and a scoped-run fake-adapter test proving ordered events from claim through Codex start, report read, configured checks/review gates, and terminal blocked/review-ready result.
- [ ] Targets: `src/runner/lifecycle-events.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/run-log.ts` only if needed for non-contract log notes.
- [ ] Exit Gate: Tests prove event order, append behavior, malformed-line read resilience, and publication-boundary ordering.

### Slice 3 - #400 Context Snapshots
- [ ] Objective: Every Codex session path writes a bounded snapshot before Codex invocation and links it from lifecycle events.
- [ ] Test/Proof First: Add failing snapshot tests for scoped implementation, parent planning, tree-child implementation, Fresh-Context Review, blocked outcome, review-ready outcome, long issue/comment bounding, and secret/transcript exclusion.
- [ ] Targets: `src/runner/context-snapshot.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/fresh-context-review.ts`, `src/runner/prompt.ts` only if existing path helpers need reuse.
- [ ] Exit Gate: Tests prove snapshot-before-Codex ordering and lifecycle `snapshot` artifact presence when a snapshot is created.

### Slice 4 - #401 Doctor
- [ ] Objective: `doctor --target <path>` reports read-only readiness in text and JSON with pass/warn/fail arrays.
- [ ] Test/Proof First: Add failing CLI/parser and readiness tests for healthy config, warnings, failures, invalid profiles, missing labels, missing base branch, missing configured checks, missing Codex command, and configured visual/mobile prerequisites.
- [ ] Targets: `src/runner/doctor-command.ts`, `src/cli.ts`, `src/index.ts`, tests with fake gh/git/codex executors.
- [ ] Exit Gate: Tests prove doctor does not launch Codex, mutate GitHub, create worktrees, or edit project files.

### Slice 5 - #402 Status JSON
- [ ] Objective: `status --target <path> --json` returns stable machine-readable state using discovery decisions, recovery, active runs, and recent lifecycle events.
- [ ] Test/Proof First: Extend `test/status-command.test.ts` with failing JSON tests for empty, eligible/skipped, active, recovery, capped recent events, newest-first ordering, and artifact references.
- [ ] Targets: `src/runner/status-command.ts`, `src/cli.ts`, `src/index.ts`, `src/runner/lifecycle-events.ts` read API if not already exposed.
- [ ] Exit Gate: Current text status tests remain unchanged unless updated only for parser additions; JSON tests prove no raw transcripts/secrets/full comments.

### Slice 6 - #403 Docs And Combined Regression
- [ ] Objective: Docs and full fake-run regression prove profile, snapshot, event, status JSON, and doctor behavior together.
- [ ] Test/Proof First: Add one failing combined regression using fake GitHub/Codex/process executors: scoped run writes snapshot/events, uses expected profile, status JSON exposes recent evidence, and doctor reports readiness.
- [ ] Targets: `README.md`, `CHANGELOG.md`, `docs/live-smoke-checklist.md`, focused tests.
- [ ] Exit Gate: Focused diagnostics tests plus `npm run typecheck` and `npm test` pass.

### Slice 7 - #404 Live Smoke Gate
- [ ] Objective: Packaged CLI live smoke covers diagnostics/profile behavior and records final live evidence.
- [ ] Test/Proof First: Add failing live-smoke helper/scenario tests proving diagnostics assertions can run through the packaged CLI path.
- [ ] Targets: `scripts/live-smoke.mjs`, `docs/live-smoke-checklist.md`, live-smoke tests.
- [ ] Local Gate Before Live: `npm run typecheck` and `npm test` pass.
- [ ] Live Gate: Run `npm run smoke:live -- --cleanup` only after local gates pass and live `gh`/Codex auth are available. If it fails due code bugs, fix and rerun failed scenario(s), then rerun full live gate. If blocked by external credentials/availability, record the exact blocker, created artifacts, cleanup status, and leave #404 unpassed.

## 5. Dependency Order
1. #398 profiles first.
2. #399 events after shared phase/profile names.
3. #400 snapshots after event artifact references exist.
4. #401 doctor after profile validation contract exists.
5. #402 status JSON after events and snapshot artifacts exist.
6. #403 docs/regression after #398-#402.
7. #404 live smoke after #403 and local gates.

## 6. Halt Conditions
- [ ] Stop if a profile contract would require changing global Codex config outside project config.
- [ ] Stop if any status/doctor/snapshot/event output would expose secrets, prompt text, raw Codex transcripts, or full issue comments.
- [ ] Stop if doctor or status needs GitHub mutation, worktree creation, Codex launch, or project-file edits to satisfy a check.
- [ ] Stop if lifecycle event ordering cannot prove review-ready publication happens only after runner-owned gates pass.
- [ ] Stop #404 if live auth or GitHub availability is missing; document the blocker instead of claiming a green live gate.

## 7. Validation And Done Criteria
- [ ] **Lint/Format:** Not configured; do not invent a lint command.
- [ ] **Typecheck:** `npm run typecheck`.
- [ ] **Tests:** `npm test`.
- [ ] **Architecture Check:** Post-implementation `$cleanup-review`, then final `$code-review`, because the wave changes shared runtime behavior across more than three files.
- [ ] **Live/Manual Validation:** #404 final gate `npm run smoke:live -- --cleanup` if credentials permit; otherwise exact blocker and cleanup status.
- [ ] **Behavior Proof:** Each child issue has focused automated proof tied to its acceptance criteria; #403 has combined fake-run regression; #404 has packaged CLI live evidence or explicit external blocker.
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## Defect Closure Notes
- [ ] `implementation-spec-review` verdict is Approved; no defects require closure before execution.

## 8. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-05-15/2211-runner-diagnostics-wave.md
Execution Model: Single-Agent
Review Verdict: Approved
Validation Gates: Local / Live / Tests
Blockers: None for local implementation; #404 live gate depends on available `gh` and Codex auth.
