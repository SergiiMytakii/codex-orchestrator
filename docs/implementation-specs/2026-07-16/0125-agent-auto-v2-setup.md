---
title: "Codex Orchestrator v2 Spec 6: typed Setup and fresh cutover"
created_at: "2026-07-17T01:25:38+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "complete"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "Setup owns the config authority switch, host-global ownership, explicit GitHub label writes, and non-destructive Legacy cutover."
  - "A crash or ambiguous Legacy owner must not leave two executable authorities or overwrite retained worktrees/state."
review_outcome: "Waived"
review_verdict: "Not run; independent artifact and code review waived by user"
review_coverage: "Root executable self-checks cover typed outcomes, config-last durability, byte-stable replay, label reconciliation, detect-only Legacy reads, continuously fenced fresh cutover, and thin CLI mapping"
approved_content_sha256: "57c9c3589b3420cc6554ed0b59013cd9a878068912c49210b1c542a33c25ac15"
source_plan_sha256: "e6dd64cdc7dbd3bec1c2734782b314443335822e8523591758230c71c6d2f6aa"
---

## 1. Execution Context

- **Goal:** Implement the approved `Setup.execute(...)` deep Module for configure, prepare-labels, fresh, doctor, and status while preserving the isolated V2 runtime and leaving the installed public bin on Legacy until Spec 8.
- **Predecessor Gate:** Specs 1-5 are complete. The V2 config schema, runtime roots, host-global owner-lock location, package assets, `RunIssue`, `AcceptanceProof`, and public outcome shapes are settled.
- **Approved Scope:** Typed Setup Interface/outcomes; minimal config and marked ignore block; origin/repository validation; config-last durability; byte-stable repeat; explicit paginated label preparation; read-only diagnostics; detect-only Legacy inspection; manifest-backed copy-only fresh cutover; candidate CLI parse/render/exit mapping; setup package-consumer tests.
- **Out of Scope:** Public `src/cli.ts`/exports/bin switch, old runtime deletion, issue execution policy, run-state initialization, live GitHub smoke, self-improvement, package publication, automatic migration, retained worktree/ref cleanup.
- **Stable Ownership:** `Setup.execute` alone decides setup/cutover/diagnostic policy. Filesystem, Git, process, and GitHub dependencies are concrete Adapters. Candidate CLI code parses, invokes, renders, and maps typed outcomes only.

## 2. Exact Interface And Defaults

```ts
interface Setup {
  execute(intent: SetupIntent): Promise<SetupOutcome>;
}

interface SetupIntent {
  targetRoot: string;
  operation: 'configure' | 'prepare-labels' | 'fresh' | 'doctor' | 'status';
  dryRun: boolean;
  repository?: { owner: string; repo: string };
}
```

- Success is exactly `created | unchanged | labels-prepared | fresh-reset | planned | inspected` with the plan's nested fields.
- Policy blockers are exactly `legacy-detected | blocked-active | repository-mismatch | unsupported-schema | labels-partial | inspected(blocked)`; operational failures are `transport-failed | io-failed` with typed bounded data.
- Default V2 config uses the existing exact schema, four V2 labels, `workspaceRoot: .codex-orchestrator/workspaces-v2`, `stateDir: .codex-orchestrator/v2/state`, proof artifacts under `.codex-orchestrator/v2/proofs`, branch template/max cycles/Codex version from the settled parser, read-only tool network, project-supported `typecheck`/`test` commands only, and deterministic denied paths/commands. The fresh workspace root is deliberately distinct from retained Legacy `.codex-orchestrator/workspaces`.
- The managed `.gitignore` block contains only the configured V2 workspace/state/proof roots that are inside the checkout. It is appended once with exact start/end markers and a terminal newline; existing unrelated bytes are preserved.
- Origin parsing accepts canonical GitHub HTTPS or SSH URLs only. Explicit repository must be complete and match persisted config and observed origin when present. Base branch comes from the local symbolic `origin/HEAD`; absent or ambiguous branch evidence fails typed rather than contacting the network.

## 3. Risk Controls

- **Config Commit Point:** Ignore write/fsync completes before the config temp rename. The config rename plus parent-directory fsync is the authority switch. No state file, worktree, package script, prompt, skill, Codex process, or GitHub mutation is created by ordinary configure.
- **Repeat Setup:** A valid exact-schema config is authoritative and byte-stable. Repeated configure validates repository identity and returns `unchanged` without rewriting config, ignore, package, or state bytes.
- **Label Authority:** Only `prepare-labels` may create labels. It reads every page, compares names case-insensitively, creates only missing V2 labels in stable policy order, reconciles already-exists by rereading, and returns typed partial progress. Config commit precedes the first create; all Adapter promises settle before lock release.
- **Detect Only:** Legacy readers accept only the narrowly recognized current version-1 shape or known experimental schema IDs and extract only repository, state/workspace paths, running-label name, and owner/lease metadata required for diagnosis/quiescence. They never call Legacy parsers or execution code.
- **Fresh Cutover:** One new host-global repository lock and one Legacy fence remain held from initial quiescence through final config fsync. Unknown/foreign/live PID evidence, active V2 owner, open running claim, GitHub read failure, nonempty V2 roots, or retained path/ref collision blocks before authority switch.
- **Copy Only:** A transaction manifest pins canonical repository, source hashes, destination roots, intended config hash, retained worktree/ref inventory, and backup paths. Legacy metadata is copied and fsynced into a timestamped backup; original bytes/paths/refs are never moved, deleted, adopted, or rewritten.
- **Crash Convergence:** Retry resumes one exact pre-commit manifest. After matching config commit, retry recognizes the unique manifest and returns `fresh-reset` with zero writes. Ambiguous manifests or a valid V2 config without its exact manifest fail closed.
- **No Second Runtime:** Setup cannot initialize `RunIssue` state or invoke issue execution. Public bin/export remains untouched in this spec.

## 4. Confirmed Targets

- `src/v2/setup.ts` — Setup Interface, typed outcomes/actions/diagnostics/failures, policy orchestration, deterministic config, ignore plan, repository matching, label reconciliation, and read-only doctor/status.
- `src/v2/setup-store.ts` — bounded no-follow reads, durable config-last/manifest/backup mechanics, direct-directory checks, injected fault points, and no setup decisions.
- `src/v2/legacy-cutover.ts` — narrow detect-only record parser, local owner/quiescence observations, transaction schema/hash validation, and retained evidence inventory.
- `src/v2/setup-cli.ts` and `src/v2/cli-contract.ts` — candidate-only parser/render/exit mapping over `SetupOutcome`; no target/config/Legacy/label branching in handlers.
- Existing `src/v2/config.ts`, `src/v2/atomic-store.ts`, Git/process primitives, and `src/setup/labels.ts`/`github-label-adapter.ts` may be reused only as leaf mechanics/Adapters; no old setup/doctor policy is imported.
- `test/v2-setup*.test.ts`, `test/v2-setup-cli.test.ts`, and package-consumer/config/runtime regressions — all Setup behavior through `Setup.execute`, with Adapter tests only for durability/parsing mechanics.

## 5. Contract Test Ledger

| Invariant | First RED proof | Status |
| --- | --- | --- |
| `Setup.execute` is the only setup policy Interface and every outcome is typed/renderable. | compile/runtime Interface and candidate CLI total-mapping tests | green |
| Clean configure writes only marked ignore bytes and config last, creates no runtime state, and converges after every injected write/fsync boundary. | temp Git repository fault matrix through `Setup.execute` | green |
| Exact-schema repeat setup is byte-stable and rejects repository/origin mismatch before writes. | before/after file digest and Adapter-call matrix | green |
| Default configure performs zero GitHub writes; dry-run returns exact ordered actions with zero local/GitHub writes. | recording filesystem/label Adapters | green |
| Explicit label preparation fully paginates, creates missing-only labels, reconciles already-exists, and returns typed partial progress. | deferred/paged label Adapter matrix | green |
| Doctor/status are read-only, deterministically ordered, and own their `ok | blocked` disposition inside Setup. | mixed clean/Legacy/unsupported/owner/label diagnostics | green |
| Legacy data is detect-only and cannot enter V2 config/runtime policy. | unknown/custom/future/minimal recognized parser matrix and import scan | green |
| Fresh holds both fences, proves local/remote quiescence, copies metadata, persists one manifest, and commits config last to separate empty roots. | Setup Interface fresh success plus active/foreign/GitHub/root/ref blockers | green |
| Every fresh crash boundary leaves one authority and exact retry converges without deleting Legacy evidence. | manifest/copy/config rename/parent fsync/result-loss matrix | green |
| Public Legacy bin remains unchanged and no setup path initializes RunIssue state. | package/export snapshot and target-tree inventory | green |

## 6. Execution Slices

### Progress Discipline

- [x] Start every behavior slice with focused RED evidence.
- [x] Keep public bin/export and all Legacy runtime files unchanged.
- [x] Run root self-checks instead of independent review per user waiver.
- [x] Never run live GitHub mutation; use fake/paged/deferred Adapters only in Spec 6.

### Slice 1 — Typed configure and durable commit

- [x] Add Interface/CLI RED tests and exact default-config/ignore snapshots.
- [x] Implement `Setup.execute(configure)` over canonical target/origin/repository evidence and a host-global lock.
- [x] Prove ignore-before-config ordering, config rename/fsync commit point, no runtime state, byte-stable repeat, mismatch/unsupported/Legacy refusal, and dry-run zero writes.
- [x] **Exit Gate:** focused configure/fault tests, typecheck, architecture scan, and diff check pass.

### Slice 2 — Labels and read-only diagnostics

- [x] Add RED paginated/case-insensitive/already-exists/partial/deferred label matrices.
- [x] Implement explicit `prepare-labels`, ensuring durable config before first mutation and full settlement before lock release.
- [x] Implement deterministic `doctor`/`status` diagnostics and Setup-owned disposition with zero writes.
- [x] Extend candidate parser/render/exit mapping without embedding policy.
- [x] **Exit Gate:** focused labels/diagnostics/CLI tests and Setup Interface-shape tests pass.

### Self-Check Checkpoint — setup authority

- [x] Root hunts config-before-ignore, config rewrite on repeat, implicit labels, partial repository override, network origin guessing, command-handler policy, run-state creation, old setup imports, free-form error routing, unlocked result, and unresolved Adapter work.

### Slice 3 — Detect-only Legacy and manifest-backed fresh

- [x] Add RED recognized/unknown/experimental/foreign/live Legacy detection and quiescence tests without importing old policy.
- [x] Implement continuously held V2/Legacy fences, local owner/start-token checks, remote running-claim observation, separate empty V2 roots, retained worktree/ref inventory, copy-only backup, and deterministic manifest.
- [x] Prove pre/post-commit crashes, result-loss replay, unique matching manifest, unrelated V2 refusal, nonempty roots, collision, ambiguity, and unchanged Legacy source bytes/refs.
- [x] **Exit Gate:** full fresh-cutover matrix and no-delete/no-adopt scan pass.

### Slice 4 — Package and regression closure

- [x] Prove installed package update preserves setup-owned target bytes without postinstall and candidate Setup resolves from package bytes.
- [x] Run all V2/full tests, typecheck, package dry-run, architecture scan, containment canary, and diff check.
- [x] Reconcile this spec/master and authorize Spec 7 only after every Setup/fresh gate is GREEN.

## 7. Halt Conditions

- [x] Stop before writes on unknown/unsupported config, incomplete repository evidence, active/foreign/ambiguous owner, remote claim-read failure, or nonempty/colliding V2 roots.
- [x] Stop if fresh would move/delete/rewrite Legacy state, worktrees, branches, refs, prompts, or config before the single V2 config commit.
- [x] Stop if Setup needs lifecycle policy, run-record writes, old setup/doctor orchestration, command-text outcome routing, or a public bin switch.
- [x] Stop live label creation because Spec 6 has no separate live GitHub authorization.

## 8. Validation And Done Criteria

- [x] Every ledger row and checklist item is GREEN.
- [x] Clean configure, byte-stable repeat, label dry-run/reconciliation, read-only diagnostics, and manifest-backed fresh are proven through `Setup.execute`.
- [x] Every crash point converges with exactly one executable authority and unchanged retained Legacy evidence.
- [x] Candidate CLI mappings are total; public bin/export remains Legacy until Spec 8.
- [x] V2/full suites, typecheck, package consumer/dry-run, architecture scan, containment canary, and diff check pass with no Setup skip.
- [x] Independent review remains `Waived`; root self-check defects are fixed and validation rerun.
- [x] Master links this spec and authorizes Spec 7 only after reconciliation.

## 9. Implementation Review State

- **Profile:** high.
- **Plan:** Independent artifact/checkpoint/cleanup/final review waived. Root performs executable setup-authority, crash-convergence, and no-Legacy-mutation self-checks.
- **Pass History:** Independent passes: none; outcome `Waived`. Root self-check covered config-last publication, byte stability, label settlement, detect-only parsing, dual-fence cutover, no-follow storage, crash replay, package bytes, and absence of runtime initialization.
- **Verified Defects:** Root self-check replaced broad Legacy classification with a bounded detect-only reader, fixed config-backup hash comparison, and closed managed-directory symlink escape by canonicalizing the target and requiring direct durable-store directories.
- **Accepted Risks:** `S6-REVIEW-WAIVER-001` — independent review omitted by user instruction. Shared Codex auth/user-readable host files remain accepted; setup/cutover/GitHub mutation authority does not.
- **Open Defects:** None.

### 9.1 Execution Evidence

- **Implementation Outcome:** GREEN. `Setup.execute` is the only policy owner for configure, prepare-labels, fresh, doctor, and status; candidate CLI code only parses, renders canonical JSON, and maps typed exits.
- **Durability Outcome:** GREEN. Configure writes ignore before config and creates no runtime state. Four injected config publication boundaries converge on retry. Fresh holds both fences, proves quiescence and empty/collision-free roots, writes one deterministic manifest and copy-only backup, then commits config last; the same four boundaries converge to one authority and one manifest.
- **Safety Outcome:** GREEN. Unsupported Legacy, mismatch, active/ambiguous owner, remote read failure, nonempty roots, retained collisions, malformed manifests, and symlinked managed directories fail closed before authority switch. Legacy state and retained refs/worktrees are not moved or deleted.
- **Package Outcome:** GREEN. Packed install/update preserves consumer-owned bytes, includes all Setup modules, and has no postinstall mutation.
- **Validation:** Focused Setup suite `33/33`; repository suite `839/839`; typecheck, containment, architecture/import/no-delete scans, `git diff --check`, bridge manifest, and 537-file package dry-run pass.
- **Skipped Live Gates:** GitHub label creation, live smoke, daemon, package publication, and public cutover remain outside Spec 6.
- **Checkpoint Commit:** `fb26412`.

## 10. Final Action

Completed: typed Setup, explicit labels, read-only diagnostics, detect-only Legacy classification, copy-only manifest-backed fresh cutover, crash convergence, and package-consumer behavior are GREEN. The master may authorize Spec 7 next.
