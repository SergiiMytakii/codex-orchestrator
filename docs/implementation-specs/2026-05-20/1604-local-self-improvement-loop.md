---
title: "Implement Local Self-Improvement Loop"
created_at: "2026-05-20T16:04:46+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-05-20/1551-local-self-improvement-loop.md"
source_issues:
  - "None"
status: "implemented-with-live-handoff-blocked"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved"
---

## 0. Implementation Result
- **Local runner:** Implemented under ignored `.codex-orchestrator/local/self-improvement/`.
- **Tracked package boundary:** Preserved; root package `src/**`, `test/**`, package config, bundled prompts, and package docs were not changed for the local feature.
- **Automation:** Created active Codex App cron automation `daily-local-codex-orchestrator-self-improvement` with `RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0`, `execution_environment = "local"`, and cwd `/Users/serhiimytakii/Projects/codex-orchestrator`.
- **Local tests:** `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` passed with 18 tests.
- **Live discovery:** Created GitHub issue #773, `Self-improvement: Deepen Acceptance Proof report loading`, with `agent:auto`, `agent:running`, and `self-improvement`.
- **Live implementation:** Codex completed implementation work for #773 in `.codex-orchestrator/workspaces/issue-773` and wrote a passing completion report, but the outer runner process was interrupted before draft PR handoff, label transition, state cleanup, and post-success `npm run smoke:live`.
- **Live review:** `node .codex-orchestrator/local/self-improvement/runner.mjs review` completed and created no runner follow-ups while #773 remained `agent:running`. Manual review of the interrupted #773 handoff created #774 with `agent:manual,self-improvement` and no `agent:auto`.

## 1. Execution Context
- **Goal:** Implement the approved local-only self-improvement runner that creates one daily `agent:auto` architecture issue, runs codex-orchestrator on that exact issue, runs live smoke only after successful targeted implementation, and creates only `agent:manual` review follow-up issues.
- **Source Material:** `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-05-20/1551-local-self-improvement-loop.md`.
- **Approved Scope:** Create ignored local runner files under `.codex-orchestrator/local/self-improvement/`, verify/add `.codex-orchestrator/local/` to `.gitignore`, create Codex App daily automation, and use live GitHub issue creation according to the plan.
- **Out of Scope:** No package feature, no `src/` runtime changes, no `test/` package tests, no `package.json`, `README.md`, `CHANGELOG.md`, `src/config/schema.ts`, `.codex-orchestrator/config.json`, or package prompt edits. No auto-merge, release publishing, `npm publish`, or broad issue creation from more than one architecture candidate.
- **Simplest Viable Path:** Build one local Node ESM runner at `.codex-orchestrator/local/self-improvement/runner.mjs` plus local prompts, state, tests, and README in the same ignored directory. Use `gh` for GitHub, direct Codex CLI calls for discovery/review JSON, `node dist/src/cli.js run --target . --issue <number>` for targeted implementation, and `npm run smoke:live` for post-implementation live smoke.
- **Primary Risk:** Live GitHub mutation can duplicate issues or run the wrong issue unless remote idempotency markers, targeted issue execution, exact `gh` query scope, and phase ordering are enforced.

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** Authenticated `gh`; GitHub write access to `SergiiMytakii/codex-orchestrator`; Codex CLI/Codex App available; Node.js from repo; network access; `self-improvement` label exists or can be created; current workspace `/Users/serhiimytakii/Projects/codex-orchestrator`; acceptance that `npm run smoke:live` creates or updates real GitHub issues and PRs during the local self-improvement loop.
- **Blocking Unknowns:** None. Automation creation is confirmed from the active Codex Desktop developer tool namespace for this task: `codex_app.automation_update` is available with `mode`, `kind`, `name`, `prompt`, `rrule`, `status`, `executionEnvironment`, and `cwds` fields for cron automations. Do not use `tool_search` as the availability check for this developer tool; `tool_search` discovers deferred MCP/plugin tools, not the already-active Codex App automation tool.
- **Confirmed Targets:** `.gitignore` currently contains `.codex-orchestrator/local/` in the worktree and must remain so; `.codex-orchestrator/local/self-improvement/runner.mjs`; `.codex-orchestrator/local/self-improvement/prompts/discovery.md`; `.codex-orchestrator/local/self-improvement/prompts/review.md`; `.codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs`; `.codex-orchestrator/local/self-improvement/README.md`; `.codex-orchestrator/local/self-improvement/state.json` created at runtime only.
- **Confirmed Commands:** `npm run build --silent`; `node dist/src/cli.js run --target . --issue <number>`; `npm run smoke:live`; `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs`; `gh repo view SergiiMytakii/codex-orchestrator --json nameWithOwner`; `gh auth status`; `gh label list --repo SergiiMytakii/codex-orchestrator --limit 1000 --json name`; `gh label create self-improvement --repo SergiiMytakii/codex-orchestrator --color 5319E7 --description "Local codex-orchestrator self-improvement loop"`; discovery issue creation uses `gh issue create --repo SergiiMytakii/codex-orchestrator --title <title> --body-file <file> --label agent:auto --label self-improvement`; review follow-up creation uses `gh issue create --repo SergiiMytakii/codex-orchestrator --title <title> --body-file <file> --label agent:manual --label self-improvement`; `gh issue list --repo SergiiMytakii/codex-orchestrator --state all --limit 100 --search "<marker> in:body" --json number,title,state,url,labels`; `gh issue view <number> --repo SergiiMytakii/codex-orchestrator --json number,title,body,state,url,labels,comments,closedByPullRequestsReferences`.
- **Confirmed Tool Calls:** `codex_app.automation_update` is available in the active Codex Desktop developer tool list for this task. Use it directly; do not attempt to rediscover it with `tool_search`. The accepted creation payload used `mode: "create"`, `kind: "cron"`, `name: "Daily local codex-orchestrator self-improvement"`, `executionEnvironment: "local"`, `cwds: ["/Users/serhiimytakii/Projects/codex-orchestrator"]`, `rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0"`, `status: "ACTIVE"`, `model: "gpt-5.3-codex"`, `reasoningEffort: "medium"`, and the prompt specified in Slice 7.
- **Protected Paths / Rejected Approaches:** Do not edit `src/**`, `test/**`, `package.json`, `README.md`, `CHANGELOG.md`, `src/config/schema.ts`, `.codex-orchestrator/config.json`, or `prompts/**`. Do not use `codex-orchestrator daemon --once` for the new issue; use targeted `run --issue`. Do not put review follow-ups on `agent:auto`. Do not run `npm run smoke:live` before targeted implementation exits with code `0`.
- **Architecture Lens:** New local Module: `runner.mjs`. Interface: commands `daily`, `discover`, `implement --issue <number>`, and `review`. Seam: direct process calls to `gh`, Codex CLI, local codex-orchestrator CLI, npm scripts, and Codex App automation; no Adapter abstraction because each has one concrete local integration. Deletion test: deleting the runner would scatter lock, fingerprints, remote marker reuse, issue templates, Codex JSON validation, and phase summaries into prompts, so the Module earns its keep.
- **Contract Test Ledger:**
  - Discovery issue labels: first proof `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` stubs issue creation and asserts exact labels `agent:auto,self-improvement` and no extra labels.
  - Review follow-up labels: first proof `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` stubs follow-up creation and asserts exact labels `agent:manual,self-improvement` and no `agent:auto`.
  - Remote idempotency: first proof `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` stubs `gh issue list --state all --search "<marker> in:body"` hit and asserts no create call occurs.
  - Targeted implementation: first proof `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` asserts implementation command includes `node dist/src/cli.js run --target . --issue <number>` and never calls daemon.
  - Daily failure isolation: first proof `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` stubs implementation failure and asserts review phase still runs after shared preflight succeeds.
  - Live smoke ordering: first proof `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` asserts `npm run smoke:live` runs only after targeted implementation exits with code `0`; nonzero implementation, missing issue number, or not-started implementation skips smoke with a reason.
  - Lock exclusivity: first proof `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` asserts a second lock acquisition fails while the lock directory exists and stale recovery requires same-host dead pid plus age above 12 hours.
  - Codex JSON capture: first proof `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` stubs Codex CLI writing non-JSON and asserts no GitHub mutation occurs.

## Risk Controls
- **Source of Truth:** `.codex-orchestrator/config.json` remains the source for canonical `agent:auto` and `agent:manual` label names; `runner.mjs` owns local-only self-improvement marker strings, issue templates, lock/state, Codex invocation, and fingerprints.
- **Safety Constraints:** Preflight must verify repo identity is exactly `SergiiMytakii/codex-orchestrator`, `gh` auth works, `agent:auto` and `agent:manual` labels exist, and `self-improvement` exists or is created before any issue mutation. No secret files may be read or printed. No package release/publish/merge command may run.
- **Contract Constraints:** Discovery Codex output must be raw JSON matching the plan schema before issue creation. Review Codex output must be raw JSON with findings containing `summary`, `evidence`, `proposedFix`, `sourceIssue`, optional `sourcePr`, and `findingFingerprint` before follow-up creation.
- **Concurrency / State Constraints:** Acquire lock via atomic `fs.mkdir(lockDir)` without `recursive`; write `lock.json` with pid, hostname, timestamp; recover stale lock only when same-host pid is not alive and lock age is over 12 hours. Treat GitHub body markers as mutation idempotency source of truth; local `state.json` is only a cache/audit log.
- **Forbidden Scope:** No package runner module, package CLI command, config schema extension, daemon selection change, package docs, release change, or package test suite change.

## Write Scope Summary
- `.gitignore` - Verify/add `.codex-orchestrator/local/`; only tracked repo change expected besides spec/plan docs.
- `.codex-orchestrator/local/self-improvement/runner.mjs` - Create ignored local runner command implementation.
- `.codex-orchestrator/local/self-improvement/prompts/discovery.md` - Create ignored discovery prompt requiring the JSON contract and stable ordering.
- `.codex-orchestrator/local/self-improvement/prompts/review.md` - Create ignored review prompt requiring evidence-only JSON findings.
- `.codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` - Create ignored local tests with stubbed process/GitHub behavior.
- `.codex-orchestrator/local/self-improvement/README.md` - Create ignored operational note; do not duplicate policy beyond command usage and local path warning.
- `.codex-orchestrator/local/self-improvement/state.json` - Runtime-created ignored state; do not commit.

## 3. Execution Slices

### Progress Discipline
- [x] Update this checklist as work is completed.
- [x] Leave blocked work unchecked with a short `Blocked:` note.
- [x] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [x] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [x] For behavior changes, start each slice with a behavior-first test/proof before implementation work.
- [x] For contract-heavy changes, update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.

### Slice 1 - Local Boundary And Test Harness
- [x] Objective: The repo has an ignored local-only workspace and no package self-improvement runtime/test files.
- [x] Test/Proof First: Run `git status --short` and verify there are no tracked or untracked `src/runner/self-improvement-command.ts` or `test/self-improvement-command.test.ts` files. Verify `.gitignore` contains `.codex-orchestrator/local/`.
- [ ] Target: `.gitignore`
  - [x] Action: Add `.codex-orchestrator/local/` only if absent; preserve existing unrelated changes.
  - [x] Validation: `rg '^\\.codex-orchestrator/local/$' .gitignore`.
- [ ] Target: `.codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs`
  - [x] Action: Create a local ignored Node test harness with stubbed command execution and fake GitHub responses.
  - [x] Validation: `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` fails initially because `runner.mjs` does not exist or exports are missing.

### Slice 2 - Preflight, Lock, And Fingerprint Core
- [x] Objective: The runner can refuse unsafe execution before GitHub mutation and can dedupe marker fingerprints deterministically.
- [x] Test/Proof First: Add local tests for repo identity failure, missing auth failure, required label detection, self-improvement label creation request, atomic lock conflict, stale lock recovery, and stable sha256 fingerprint output.
- [ ] Target: `.codex-orchestrator/local/self-improvement/runner.mjs`
  - [x] Action: Implement exported helpers for command execution injection, `preflight`, `withLock`, `fingerprintCandidate`, `fingerprintFinding`, `searchIssueByMarker`, and state load/save.
  - [x] Validation: `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` passes Slice 2 tests.
- [ ] Target: `.codex-orchestrator/local/self-improvement/README.md`
  - [x] Action: Document commands `node runner.mjs daily`, `node runner.mjs discover`, `node runner.mjs review`, and warn that the directory is ignored/local-only.
  - [x] Validation: README contains no package-facing instructions or policy source of truth beyond command usage.

### Slice 3 - Codex JSON Invocation
- [x] Objective: Discovery and review can invoke Codex deterministically and capture raw JSON without mutating GitHub on invalid output.
- [x] Test/Proof First: Add local tests for the exact Codex CLI command, timeout propagation, report-file parsing, invalid JSON blocking mutation, and nonzero Codex exit blocking mutation.
- [ ] Target: `.codex-orchestrator/local/self-improvement/runner.mjs`
  - [x] Action: Implement `runCodexJson({ phase, promptPath, contextText, reportPath })`. It must run `/Applications/Codex.app/Contents/Resources/codex exec --cd /Users/serhiimytakii/Projects/codex-orchestrator --sandbox workspace-write --add-dir /Users/serhiimytakii/Projects/codex-orchestrator/.codex-orchestrator/local/self-improvement -c sandbox_workspace_write.network_access=true --output-last-message <reportPath> -` with stdin equal to the prompt plus context. Use timeout `1800000` ms. Parse `<reportPath>` as JSON. If the command exits nonzero, the report is missing, or JSON validation fails, return a failed phase result and do not mutate GitHub.
  - [x] Validation: Local tests pass and command arguments match exactly except for temporary report path.

### Slice 4 - Discovery Create-Or-Reuse
- [x] Objective: Discovery validates one candidate and creates or reuses exactly one `agent:auto` self-improvement issue with remote markers.
- [x] Test/Proof First: Add local tests where valid JSON with two candidates creates only candidate index 0; invalid/missing fields create no issue; existing marker search reuses issue; created issue body includes ownership metadata and markers.
- [ ] Target: `.codex-orchestrator/local/self-improvement/prompts/discovery.md`
  - [x] Action: Write prompt requiring `improve-codebase-architecture`, raw JSON schema, stable ordering, and no markdown wrapper.
  - [x] Validation: Prompt includes `candidates[0]`, smallest blast radius ordering, no ADR conflict rule, and required fields from the plan.
- [ ] Target: `.codex-orchestrator/local/self-improvement/runner.mjs`
  - [x] Action: Implement `discover` command: call `runCodexJson` with `prompts/discovery.md`, parse/validate JSON, reject invalid candidates, compute `source-candidate-fingerprint`, search all GitHub issues with `gh issue list --repo SergiiMytakii/codex-orchestrator --state all --limit 100 --search "source-candidate-fingerprint:<fingerprint> in:body" --json number,title,state,url,labels`, create issue with `agent:auto` and `self-improvement` if missing, and update state after remote mutation.
  - [x] Validation: Local tests pass and live discovery created #773.

### Slice 5 - Targeted Implementation And Live Smoke
- [ ] Objective: The runner implements the intended discovery issue and runs live smoke exactly once only after successful targeted implementation. Blocked: live #773 outer runner was interrupted after Codex completion but before runner handoff exit code `0`.
- [x] Test/Proof First: Add local tests that `implement --issue 123` runs `npm run build --silent` then `node dist/src/cli.js run --target . --issue 123`, never calls daemon, and that `daily` runs `npm run smoke:live` only when targeted implementation exits with code `0`.
- [ ] Target: `.codex-orchestrator/local/self-improvement/runner.mjs`
  - [x] Action: Implement `implement --issue <number>` and `runLiveSmoke`. Implementation success is exactly exit code `0` from `node dist/src/cli.js run --target . --issue <number>`. Run `npm run smoke:live` only after that success. For nonzero implementation exit, missing issue number, or implementation not started, record `live-smoke: skipped` with a reason.
  - [ ] Validation: Local tests pass; live command shows the targeted issue number in summary; smoke result is recorded as pass/fail/skipped with command output summary. Blocked: #773 is still `agent:running`; rerunning targeted implementation would conflict with the preserved worktree.

### Slice 6 - Review Create-Or-Reuse Manual Follow-Ups
- [x] Objective: Review scans eligible self-improvement issues and creates or reuses only `agent:manual` follow-up issues for concrete workflow problems.
- [x] Test/Proof First: Add local tests where eligible `agent:review` source issue with finding creates one manual follow-up; `agent:running` and `agent:blocked` sources are skipped; duplicate `finding-fingerprint` reuses existing issue; no created review issue contains `agent:auto`.
- [ ] Target: `.codex-orchestrator/local/self-improvement/prompts/review.md`
  - [x] Action: Write prompt restricting evidence to issue body/comments/labels, linked PR metadata/body, runner reports referenced by comments, and smoke result summaries. Require raw JSON findings schema.
  - [x] Validation: Prompt forbids chat-history inference and requires `proposedFix` plus evidence.
- [ ] Target: `.codex-orchestrator/local/self-improvement/runner.mjs`
  - [x] Action: Implement `review` command: list candidate sources with `gh issue list --repo SergiiMytakii/codex-orchestrator --state all --limit 100 --search "self-improvement-runner-id:codex-orchestrator-local-self-improvement in:body" --json number,title,state,url,labels`; for each candidate, fetch full evidence with `gh issue view <number> --repo SergiiMytakii/codex-orchestrator --json number,title,body,state,url,labels,comments,closedByPullRequestsReferences`; filter eligible sources; cap to five sources and five findings per source; call `runCodexJson` with `prompts/review.md`; validate finding JSON; search duplicates with `gh issue list --repo SergiiMytakii/codex-orchestrator --state all --limit 100 --search "finding-fingerprint:<fingerprint> in:body" --json number,title,state,url,labels`; create `agent:manual,self-improvement` follow-ups when missing; update reviewed fingerprint state.
  - [x] Validation: Local tests pass; live review completed with `created=0 reused=0` while #773 remained ineligible because it is `agent:running`; manual review follow-up #774 was created with `agent:manual,self-improvement`.

### Slice 7 - Daily Orchestration And Codex App Automation
- [ ] Objective: One daily command runs preflight, discovery, targeted implementation, live smoke, and review with separate phase results, then Codex App automation runs it daily. Blocked: one live daily run started #773 but outer handoff was interrupted before complete exit.
- [x] Test/Proof First: Add local tests where discovery failure still runs review, implementation failure still runs review, live-smoke failure still runs review, and shared preflight failure stops all mutation phases.
- [ ] Target: `.codex-orchestrator/local/self-improvement/runner.mjs`
  - [x] Action: Implement `daily`: acquire lock, run preflight, run discovery, run implementation only when discovery produced/reused an issue number, run live smoke only after implementation exit code `0`, always run review after preflight, print phase summary with created/reused/skipped/failed statuses, and exit nonzero if any phase failed while still printing all phase results.
  - [ ] Validation: Local tests pass; live `node .codex-orchestrator/local/self-improvement/runner.mjs daily` produces a phase summary for `preflight`, `discover`, `implement`, `live-smoke`, and `review`. Blocked: #773 still has `agent:running` and preserved local worktree after interrupted outer runner.
- [ ] Target: Codex App automation
  - [x] Action: Create a Codex App cron automation with the currently available `codex_app.automation_update` tool and accepted payload: `{"mode":"create","kind":"cron","name":"Daily local codex-orchestrator self-improvement","executionEnvironment":"local","cwds":["/Users/serhiimytakii/Projects/codex-orchestrator"],"rrule":"RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0","status":"ACTIVE","model":"gpt-5.3-codex","reasoningEffort":"medium","prompt":"Run node .codex-orchestrator/local/self-improvement/runner.mjs daily from /Users/serhiimytakii/Projects/codex-orchestrator and report the phase summary. Do not modify package source files."}`.
  - [x] Validation: `codex_app.automation_update` returned `daily-local-codex-orchestrator-self-improvement`; inspected saved automation and confirmed it is active, daily, local, and bound to `/Users/serhiimytakii/Projects/codex-orchestrator`.

### Slice Exit Gate
- [x] `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs` passes.
- [x] `git status --short` shows only intended tracked changes (`.gitignore` and spec/plan docs) and ignored local runner files do not appear as untracked.
- [ ] One live daily command has run or is blocked only by a documented external precondition. Blocked: #773 remains `agent:running` after interrupted outer runner.
- [ ] If the live daily command reaches implementation success, `npm run smoke:live` has run afterward and its result is in the daily summary. Blocked: #773 did not reach runner handoff exit code `0`.

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** Not applicable; no lint script is configured.
- [ ] **Typecheck:** Not applicable for ignored local `.mjs` runner unless tracked TypeScript package files are changed. If any tracked TypeScript package file changes, stop because scope was violated.
- [x] **Tests:** `node --test .codex-orchestrator/local/self-improvement/self-improvement-runner.test.mjs`.
- [ ] **Architecture Check:** Not applicable; no dedicated architecture-check script is configured.
- [ ] **Live/Manual Validation:** `node .codex-orchestrator/local/self-improvement/runner.mjs daily`, including live GitHub issue creation/reuse, targeted `run --issue`, post-success `npm run smoke:live`, review follow-up creation/reuse, and Codex App automation creation. Blocked after issue creation and Codex implementation because outer runner was interrupted before PR handoff and smoke.
- [ ] **Behavior Proof:** Daily summary shows separate `preflight`, `discover`, `implement`, `live-smoke`, and `review` phase outcomes, issue numbers, PR numbers when available, and created-vs-reused status. `live-smoke` is `passed` or `failed` only after implementation exit code `0`; otherwise it is `skipped` with a reason. Blocked on #773 runner handoff.
- [x] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.

## Halt Conditions
- [ ] `gh repo view` does not return `SergiiMytakii/codex-orchestrator`.
- [ ] Required labels `agent:auto` or `agent:manual` are missing.
- [ ] `self-improvement` label is missing and `gh label create self-improvement` fails.
- [ ] Codex CLI discovery/review command cannot produce parseable raw JSON at the configured report path.
- [ ] Any implementation step requires editing `src/**`, `test/**`, package config, package docs, `.codex-orchestrator/config.json`, or package prompts.
- [ ] `codex_app.automation_update` is not available in the implementation environment or rejects the exact cron payload in Slice 7.

## Defect Closure Notes
- [x] Fixed live-smoke rule: smoke runs only after targeted implementation exits with code `0`; implementation nonzero skips smoke with reason.
- [x] Fixed Codex invocation ambiguity: discovery/review use an exact Codex CLI command with `--output-last-message <reportPath>` and JSON validation.
- [x] Fixed GitHub marker ambiguity: marker searches use `gh issue list --state all --search "<marker> in:body"` and full evidence uses `gh issue view`.
- [x] Fixed automation ambiguity: daily schedule uses `codex_app.automation_update` with exact cron fields and local cwd.
- [x] Fixed automation evidence gap from the second and third reviews: the spec records that `codex_app.automation_update` is callable from the active Codex Desktop developer tool namespace, not via `tool_search`, and includes the exact payload.
- [x] Fixed issue creation placeholder from the second review: `gh issue create` commands now list exact labels for discovery and review follow-up issues.

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready / Blocked
Saved Path: docs/implementation-specs/...
Execution Model: Single-Agent / Multi-Agent
Review Verdict: <implementation-spec-review verdict>
Validation Gates: Local / Live / Tests
Blockers: <unresolved blockers or None>
