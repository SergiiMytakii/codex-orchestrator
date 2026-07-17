---
title: "Issue 1226 - package-owned agent:auto workflow closure"
created_at: "2026-07-17T15:34:04+03:00"
source_type: "issue"
source_plan: "None"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1225"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/1226"
status: "completed"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "The ticket changes package provenance, content-addressed workflow generations, immutable runtime snapshots, and agent authority policy used by every downstream ticket."
  - "A missing transitive asset or mutable generation can make active runs depend on ambient user state or silently change authority after a package update."
review_outcome: "Approved"
review_verdict: "Approved"
review_coverage: "Architecture/Execution and Failure/Contracts covered by two independent Full reviews and six same-session affected-lens Closures"
---

## 1. Execution Context

- **Goal:** Ship one verified package-owned workflow closure and pin every contained attempt to its immutable content-addressed generation without reading consumer or target `~/.codex` at runtime.
- **Source Material:** Parent planning context #1225 and child implementation ticket #1226. The baseline is `codex-orchestrator@2.0.1` at `763998d`.
- **Approved Scope:** Release-time import/sync, package manifest and inventory, selected delivery skills and metadata, reviewer/implementer profiles, shared review-loop references, a fresh ambiguity-review operation, package loading, immutable generation materialization, attempt snapshots, authority validation, and deterministic/package-consumer tests.
- **Out of Scope:** Triage state transitions, waiting-human labels/answers, direct/spec orchestration, spec freezing, changed Acceptance Proof semantics, live smoke, package publication, and consumer postinstall mutation.
- **Simplest Viable Path:** Extend the existing `internal-skills` package surface into a manifest-backed `internal-workflow` closure; sync it only through an explicit maintainer script; load and seal it once per content hash; persist one generation receipt on each new `RunRecord`; and publish every implementation/rework/proof attempt from that receipt while preserving the existing implementation and Acceptance Proof behavior until downstream tickets replace orchestration.
- **Primary Risk:** Runtime or snapshot code accepts a stale, incomplete, mutable, authority-bearing, or ambient workflow tree.

## 2. Preconditions And Evidence

- **Required Services / Env / Fixtures:** Node.js and npm only for implementation/AFK proof. Explicit maintainer sync uses `${CODEX_HOME:-$HOME/.codex}` as source plus repository-owned overlays; tests use temporary synthetic source roots and never mutate the real source. Source-free shipped-tree verification runs in CI/prepack. Authenticated containment canary and live GitHub smoke are not acceptance gates for this ticket.
- **Blocking Unknowns:** None.
- **Confirmed Targets:** `package.json`; `.github/workflows/npm-publish.yml`; `internal-skills/agent-auto/**`; `internal-skills/acceptance-proof/**`; `src/v2/candidate-cli.ts` (`executeProductionRun`); `src/v2/run-store.ts` (`RunRecordV1`); `src/v2/run-issue.ts` (`RunIssueDependencies`, `createRun`, `startNextCycle`); `src/v2/runtime-assets.ts`; `src/v2/runtime.ts` (`createV2Runtime`, `prepareContainedAttempt`, `ContainedImplementationAgent`, `ContainedProofAgent`); `test/v2-run-store.test.ts`; `test/v2-run-issue.test.ts`; `test/v2-runtime-assets.test.ts`; `test/v2-package-consumer.test.ts`. Baseline has no release-time workflow importer and only the two compact skills.
- **Confirmed Commands:** `npm run sync:workflow`, `npm run check:workflow`, `npm run verify:workflow`, `npm run typecheck`, `npm test`, `npm pack --dry-run --json`.
- **Protected Paths / Rejected Approaches:** Do not read or edit `.env*`; do not read user/target workflow files at runtime; do not add postinstall mutation, dynamic network/plugin/MCP loading, publication credentials, agent-side GitHub writes, fallback to legacy `internal-skills`, or automatic live smoke.
- **Ownership / New Boundaries:** `internal-workflow/manifest.json` is the only package inventory and authority source. `src/v2/workflow-assets.ts` owns package-manifest validation and generation materialization. `src/v2/runtime-assets.ts` owns attempt snapshot publication from one verified generation. `RunRecordV1.workflowGeneration` is the sole run-level pin and is passed through `RunIssue` to implementation and proof calls; `startNextCycle` must not refresh it. The new workflow-assets Module passes the deletion test because removing it would duplicate provenance, hash, containment, and sealing checks across runtime attempts.

## Risk Controls

- **Source of Truth:** `scripts/agent-auto-workflow-source.json` declares the exact roots below; generated `internal-workflow/manifest.json` is the sole shipped inventory. Its `files` array hashes every shipped regular file except `manifest.json`, whose canonical bytes are verified by the explicit generation-hash rule below.
- **Safety Constraints:** Import and runtime reject symlinks, special files, path escapes, non-NFC/backslash/empty-dot paths, personal absolute paths in shipped text, undeclared helpers/profiles, source modes other than `0644`/`0755`, credentials/publication authority, and mutable or owner-mismatched materialized files. Runtime does not read workflow/config/rules/skills from consumer, target, or personal Codex roots. Existing shared Codex authentication remains unchanged and is never copied into workflow assets.
- **Contract Constraints:** `WorkflowManifestV1` has exact keys `version`, `sourceFingerprint`, `generationHash`, `files`, `skills`, `profiles`, `operations`; unknown keys fail. Paths are NFC forward-slash relative paths sorted by raw UTF-8 bytes. `files[]` has exact keys `path`, `mode`, `size`, `sha256`, with mode `0644` or `0755`. `sourceFingerprint = SHA256(UTF8("codex-orchestrator-workflow-source-v1\\0" + canonicalJson({files})))`. `generationHash = SHA256(UTF8("codex-orchestrator-workflow-generation-v1\\0" + canonicalJson({...manifest, generationHash:""})))`; package version is not part of this content identity. Canonical JSON sorts object keys by raw UTF-8 bytes, emits arrays in manifest order, has no insignificant whitespace, and `manifest.json` is that canonical object plus one LF. Sealed files map `0644→0444`, `0755→0555`; directories are `0555`. Each operation policy also records exact effective `sandboxMode`, `cwdClass`, and Runner postcondition; runtime validates the selected operation and passes that policy into `CodexProcess` rather than allowing caller widening.
- **Concurrency / State Constraints:** Generation and attempt publishers use an atomic no-replace hard-link claim. A publisher first writes/fsyncs a complete candidate owner record `{version:1,status:"building",bootId,pid,token,parentToken:null,startedAt}` in the same parent, then `link(candidate, <identity>.claim)` atomically binds owner identity before any fixed destination exists. On dead/different-boot owner, a reclaimer writes a new record with `parentToken:<current-leaf-token>` and races `link(candidate, <identity>.recovery.<current-leaf-token>)`; exactly one link wins, and a later crash extends the same deterministic chain. Before every mutation, a publisher resolves the chain and proves its token is the unique leaf. The leaf owner creates `<identity>.content` with `mkdir`; any content that predates a valid claim fails closed, while partial content created under the claim may be removed/rebuilt only by the current leaf. For every regular file under sealed content (including its manifest), build raw-UTF-8-path-sorted evidence `{path,sealedMode,size,sha256}` and compute `contentSha256 = SHA256(UTF8("codex-orchestrator-sealed-content-v1\\0" + canonicalJson({files})))` using the same canonical JSON rule. After content is verified, sealed, and fsynced, the leaf writes/fsyncs exact ready receipt `{version:1,status:"ready",contentSha256}` and no-replace links it to `<identity>.ready`; consumers/reclaimers recompute the same digest before accepting. Claim/recovery/ready links and content are never overwritten. Live owners cause bounded wait/requeue. Separate generation and attempt child-process kill matrices cover before/after claim link, after content mkdir/first file, before/after content fsync, before/after ready link, and after parent fsync; corrupt preexisting empty directory, regular file, symlink, special entry, malformed chain, and ready/content mismatch all fail closed.
- **Run Pin And Migration:** New runs materialize a generation before the first contained attempt and persist exact `workflowGeneration: {generationHash, manifestSha256, packageVersion, generationRoot}`. All implementation, report-repair, rework, cleanup/review stages added later, and proof receive this receipt; package source is never re-read for an active run. A baseline nonterminal V1 record has no full-closure digest and therefore cannot be safely assigned new authority: resume fails closed with typed `workflow-generation-unrecoverable` evidence. Terminal V1 records remain readable as history and need no pin. `startNextCycle` preserves the pin.
- **Forbidden Scope:** No triage state transition, durable route state, waiting-human state, spec approval record, implementation review state, label change, or publication transition is introduced here. The package-owned `triage-route-v1` operation output schema is explicitly in scope as a downstream interface only.
- **Early Review Gate:** After Slice 2 first proves manifest validation plus atomic immutable generation reuse/tamper rejection, run `$code-review` with runtime correctness, source authority, path containment, hash/mode/owner drift, crash windows, concurrency, and duplicate-source-of-truth focus. Continue only after all high/critical findings are verified fixed.
- **Final Handoff Requirements:** Report exact inventory counts and generation hash, authority/containment proof, early/final review outcomes, validation, skipped live checks, residual risks, and files grouped by generated assets, runtime owner, tests, and docs.

## 3. Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Canonical manifest framing yields the exact golden `generationHash` and any byte/path/mode/cardinality change changes it. | Importer/runtime compute different content identities. | `workflow loader binds exact operation mappings and canonical manifest bytes`. | green |
| Import snapshots the initial regular-file path/mode/size/hash set and publishes nothing when any source changes during traversal/read/recheck. | One generated closure combines bytes that never coexisted. | Complete pre/post source inventory plus no-follow inode recheck in importer; stable-sync test. | green |
| A second unchanged sync has the identical recursive `(path,mode,size,sha256)` digest and `check` detects stale output without mutation. | Release assets drift from reviewed source. | `workflow sync is byte and mode stable and check rejects stale generated bytes`. | green |
| Every operation resolves exactly one declared entry, schema, profile, closure, and policy; missing/extra/tampered assets fail closed. | Partial closure or undeclared authority reaches runtime. | Exact runtime/source-free binding validation and workflow-assets negative tests. | green |
| `triage-route-v1` transport schema and semantic validator form one exact discriminated contract. | #1227 must invent route semantics or Structured Outputs rejects the schema. | `test/v2-triage-route.test.ts` parity matrix. | green |
| New `RunRecord` persists one generation and implementation/rework/proof after package replacement/restart use the same receipt. | Active run switches workflow after update. | Restart test makes replacement generation factory throw and still reaches review-ready. | green |
| Every baseline nonterminal V1 record fails closed because it lacks a full generation digest; terminal V1 history remains readable. | Migration silently assigns unverified new authority to old work. | Store and public `runIssue` typed migration tests. | green |
| Concurrent publishers converge through one no-replace hard-link claim/recovery chain and token-bound ready receipt; invalid destinations are never overwritten. | Ownerless crash windows or plain rename replace authority. | Concurrent, tamper, symlink-root, ready-invalid, and SIGKILL tests. | green |
| Generation and attempt writers, consumers, and reclaimers derive the same domain-separated digest from sealed file evidence. | A valid snapshot is rejected or a mismatched ready receipt is accepted. | Shared `sealedWorkflowContentSha256` and mode mapping exercised by generation/attempt tests. | green |
| SIGKILL at each generation durable boundary yields absent or fully verifiable destination and later publication converges. | In-process exception tests miss generation crash windows. | Child-process `workflow generation converges after publisher process death at every ready boundary`. | green |
| SIGKILL at each attempt-snapshot durable boundary yields absent or fully verifiable destination and no stale lock blocks retry. | Existing token lock can wedge one attempt forever. | Child-process `operation snapshot converges after publisher process death at every ready boundary`. | green |
| Runtime rejects caller policy widening and launches current implementation/proof with manifest-declared profile/sandbox/cwd plus Runner postconditions; all operations deny network/MCP/external write/credentials. | Metadata claims weaker authority than effective Codex launch. | Codex argv policy tests, profile parser assertion, and manifest policy negatives. | green |

## 4. Approved Workflow Inventory And Interfaces

### Source roots

- **Repository-owned compatibility skills:** `internal-skills/agent-auto/**`, `internal-skills/acceptance-proof/**`.
- **Personal-skill roots imported with full transitive relative-file closure:** `triage`, `small-task-implementer`, `implementation-spec-maker`, `implementation-spec-review`, `spec-implementer`, `tdd`, `diagnosing-bugs`, `codebase-design`, `cleanup-review`, `code-review`, `research`, `ui-evidence-proof`.
- **Required metadata:** every skill destination contains `SKILL.md` and `agents/openai.yaml`; exact overlays are `scripts/runtime-workflow-overlays/skills/agent-auto/agents/openai.yaml`, `scripts/runtime-workflow-overlays/skills/acceptance-proof/agents/openai.yaml`, and `scripts/runtime-workflow-overlays/skills/implementation-spec-review/agents/openai.yaml`. No conditional metadata synthesis is allowed.
- **Shared docs direct roots plus their relative closure:** `artifact-review-loop.md`, `implementation-review-loop.md`, `review-protocol.md`, `review-gates.md`, `confidence-rubric.md`, `contract-test-ledger.md`, `bug-workflow-routing.md`, `coding-skill-routing.md` under `docs/agents/`.
- **Profiles:** exact source map `analyst_deep→${CODEX_HOME}/agents/analyst-deep.toml`, `implementer_deep→${CODEX_HOME}/agents/implementer-deep.toml`, `implementer_standard→${CODEX_HOME}/agents/implementer-standard.toml`, `researcher_standard→${CODEX_HOME}/agents/researcher-standard.toml`, `reviewer_deep→${CODEX_HOME}/agents/reviewer-deep.toml`, `reviewer_fast→${CODEX_HOME}/agents/reviewer-fast.toml`, `reviewer_standard→${CODEX_HOME}/agents/reviewer-standard.toml`; plus repository-owned `proof_agent→scripts/runtime-workflow-overlays/profiles/proof-agent.toml` with `sandbox_mode="workspace-write"` and proof-only instructions.
- **Repository overlays:** output schemas, the proof profile, metadata files above, and exact wrappers `scripts/runtime-workflow-overlays/operations/implementation/SKILL.md`, `scripts/runtime-workflow-overlays/operations/acceptance-proof/SKILL.md`, `scripts/runtime-workflow-overlays/operations/triage/SKILL.md`, `scripts/runtime-workflow-overlays/operations/ambiguity-review/SKILL.md`, `scripts/runtime-workflow-overlays/operations/spec-author/SKILL.md`, `scripts/runtime-workflow-overlays/operations/spec-review/SKILL.md`, `scripts/runtime-workflow-overlays/operations/spec-implementation/SKILL.md`, `scripts/runtime-workflow-overlays/operations/cleanup-review/SKILL.md`, and `scripts/runtime-workflow-overlays/operations/code-review/SKILL.md`. Overlays may adapt only authority wording/relative package paths declared in `adaptations[]`, never product behavior.

### Operation records

| ID | Entrypoint | Source Skill | Output schema | Profile | Allowed write class |
| --- | --- | --- | --- | --- | --- |
| `implementation` | `operations/implementation/SKILL.md` | `agent-auto` | `schemas/implementation-report-v1.json` | `implementer_standard` | `worktree` |
| `acceptance-proof` | `operations/acceptance-proof/SKILL.md` | `acceptance-proof` | `schemas/proof-report-v1.json` | `proof_agent` | `worktree` with `proof-only` postcondition |
| `triage` | `operations/triage/SKILL.md` | `triage` | `schemas/triage-route-v1.json` | `analyst_deep` | none |
| `ambiguity-review` | `operations/ambiguity-review/SKILL.md` | `null` (package-native wrapper) | `schemas/ambiguity-review-v1.json` | `reviewer_deep` | none |
| `spec-author` | `operations/spec-author/SKILL.md` | `implementation-spec-maker` | `schemas/spec-author-v1.json` | `implementer_standard` | `target-state` |
| `spec-review` | `operations/spec-review/SKILL.md` | `implementation-spec-review` | `schemas/spec-review-v1.json` | `reviewer_deep` | none |
| `spec-implementation` | `operations/spec-implementation/SKILL.md` | `spec-implementer` | `schemas/implementation-report-v1.json` | `implementer_standard` | `worktree` |
| `cleanup-review` | `operations/cleanup-review/SKILL.md` | `cleanup-review` | `schemas/code-review-v1.json` | `reviewer_standard` | none |
| `code-review` | `operations/code-review/SKILL.md` | `code-review` | `schemas/code-review-v1.json` | `reviewer_deep` | none |

Every operation wrapper is package-owned, forbids external effects, and requires its assigned JSON schema output; it adapts the named source skill's chat output without changing its product/review/TDD rules. `ambiguity-review` is the sole package-native wrapper and uses literal `sourceSkill:null`. Every operation record has exact keys `id`, `entry`, `sourceSkill`, `outputSchema`, `profile`, `files`, `policy`; `sourceSkill` is a declared skill ID or null only for ambiguity-review, and `files` is the wrapper plus source skill closure. `policy` has exact keys `sandboxMode`, `cwdClass`, `worktreeAccess`, `writableRootClasses`, `runnerPostcondition`, `network`, `networkHosts`, `mcpTools`, `approvalCeiling`, `externalWrite`. Implementation/spec-implementation use `workspace-write/worktree/write/worktree/change-set`; Acceptance Proof uses `workspace-write/worktree/write/worktree/proof-only`; spec-author uses `workspace-write/target-state/write/target-state/spec-only`; all read-only operations use `read-only/worktree/read-only/[]/report-only`. Every policy uses `network:"deny"`, empty hosts/tools, `approvalCeiling:"never"`, and `externalWrite:false`. Current implementation/proof launches must enforce these exact values; later operations cannot launch until their caller supplies the matching cwd and postcondition.

`src/v2/triage-route.ts` owns both `triageRouteOutputSchema()` and `validateTriageRoute()`. The transport schema is Structured Outputs-compatible: no `uniqueItems` or unsupported keywords. It rejects unknown keys at every object and has exact required top-level keys `version`, `status`, `inspectedEvidence`, `assumptions`, `direct`, `specRequired`, `awaitingUser`, `blocker`. `version` is integer constant `1`; `status` is exactly `direct|spec-required|awaiting-user|blocked`. Exactly the payload mapped by status is a non-null object and the other three payloads are required literal `null`. `inspectedEvidence` has `minItems:1`; each item has exact nonempty-string keys `kind`, `location`, `summary`, with kind `issue|comment|code|caller|test|instruction|context|domain|adr|behavior`. `assumptions` is an array of nonempty strings and may be empty. `direct` has exact nonempty `summary`, `behaviors`, `verification`; both arrays contain nonempty strings with `minItems:1`. `specRequired` has exact nonempty `summary`, `complexityReasons`, `specMode`, `reviewFocus`; both arrays contain nonempty strings with `minItems:1`, and mode is `compact|standard`. `awaitingUser` has exact nonempty `outcomes`, `absenceOfAuthorizedChoiceEvidence`, `recommendation`, `question`; outcomes has `minItems:2`, and each item has exact nonempty-string `id`, `title`, `behaviorDelta` plus nonempty-string `evidence` with `minItems:1`; absence evidence contains nonempty strings with `minItems:1`. `blocker` has exact nonempty `kind`, `code`, `summary`, `evidence`; kind is `external|safety|exhausted`, evidence contains nonempty strings with `minItems:1`. `validateTriageRoute()` first validates the transport shape, then enforces uniqueness for every semantic string-set array and `outcomes[].id`; duplicate values fail. #1227 may add Runner state transitions but may not change this module contract without revising #1226 authority. `ambiguity-review-v1` has exact keys `version`, `candidateSha256`, `verdict`, `evidenceReviewed`, `findings`, `recommendation`; verdict is `approved|rejected|blocked`. `spec-author-v1` has `version`, `status`, `specPath`, `specSha256`, `summary`, `blockers`. `spec-review-v1` has `version`, `verdict`, `mode`, `coverage`, `defects`, `reviewerSessionId`. `code-review-v1` has `version`, `verdict`, `mode`, `coverage`, `defects`, `residualRisks`, `reviewerSessionId`. Existing implementation/proof schemas keep their current semantic fields.

## 5. Write Scope Summary

- `scripts/agent-auto-workflow-source.json` - Create; explicit source/overlay allowlist, adaptations, profile and operation declarations.
- `scripts/sync-agent-auto-workflow.mjs` - Create; deterministic import/check implementation with injectable roots for tests.
- `scripts/runtime-workflow-overlays/**` - Create; package-owned existing operation assets, missing declared metadata, schemas, and fresh ambiguity-review workflow.
- `internal-workflow/**` - Create generated closure and `manifest.json`; replace package publication of `internal-skills` while preserving source-only baseline assets until migration is proven.
- `src/v2/workflow-assets.ts` - Create; strict manifest loader, authority validator, generation materializer/verifier, and typed `WorkflowGenerationReceipt`.
- `src/v2/triage-route.ts` - Create; production-equivalent Structured Outputs schema plus semantic validator for the shipped route interface.
- `src/v2/runtime-assets.ts` - Update; publish operation-scoped immutable attempt snapshots from a verified generation rather than a hard-coded two-skill inventory.
- `src/v2/runtime.ts` - Update; prepare existing implementation/proof attempts through the package generation receipt without ambient fallback.
- `src/v2/containment.ts`, `src/v2/codex-process.ts` - Update; accept and enforce the selected manifest operation policy, reject caller widening, and preserve existing shared auth handling.
- `src/v2/run-store.ts`, `src/v2/run-issue.ts` - Update; persist, validate, migrate, and preserve the run-level workflow generation receipt.
- `src/v2/candidate-cli.ts` - Update; replace direct `internal-skills` reads with verified manifest/generation initialization and compatibility hashes.
- `package.json` - Update; package `internal-workflow` and add explicit `sync:workflow`/`check:workflow` release gates.
- `.github/workflows/npm-publish.yml` - Update; run source-free `npm run verify:workflow` before publish (also enforced by `prepack`).
- `test/v2-workflow-import.test.ts`, `test/v2-workflow-assets.test.ts`, `test/v2-triage-route.test.ts` - Create; importer/manifest/generation and route schema-validator parity contracts.
- `test/v2-run-store.test.ts`, `test/v2-run-issue.test.ts`, `test/v2-runtime-assets.test.ts`, `test/v2-package-consumer.test.ts` - Update; pin/migration, snapshot, clean HOME, conflicting skills, authority, crash, race, and package-update proof.
- `README.md`, `docs/deep-dive.md`, `CHANGELOG.md` - Update only with the package-owned workflow/provenance boundary introduced by this ticket; later route behavior remains undocumented until implemented.

## 6. Execution Slices

### Progress Discipline

- [x] Update this checklist and ledger as work completes; leave blocked work unchecked with a concrete note.
- [x] Use one observable RED -> GREEN cycle per contract and test only through importer CLI, manifest loader/materializer, or contained-attempt seams.
- [x] Stop if source references cannot be represented without ambient paths, if a required profile/metadata asset is absent and has no declared overlay, or if existing V2 containment would need weaker authority.
- [x] Git checkpoint strategy: `none`; #1226 receives one focused commit only after its full review and validation pass.

### Slice 1 - Deterministic release-time closure

- [x] Add failing importer tests proving selected skills include transitive relative references, helpers/templates, each `agents/openai.yaml`, shared loop docs, declared role TOMLs, current `agent-auto`/`acceptance-proof` assets, and a fresh `ambiguity-review` operation.
- [x] Implement `scripts/agent-auto-workflow-source.json`, overlays, and `scripts/sync-agent-auto-workflow.mjs` so `sync` writes a byte-stable sorted tree/manifest and `check` compares expected bytes without mutation.
- [x] Add negative fixtures for broken links, missing/extra generated files, symlink/special entry, path escape, personal absolute path, undeclared helper/profile, unsafe mode, and stale hash/size/mode.
- [x] Add the dedicated `triage-route-v1` transport/semantic parity matrix from the Contract Test Ledger through `triageRouteOutputSchema()` and `validateTriageRoute()`.
- [x] Generate `internal-workflow/**` from the real declared local source; capture its recursive `(path,mode,size,sha256)` digest before and after a second sync and require exact equality.

### Slice 1 Exit Gate

- [x] `node --test dist/test/v2-workflow-import.test.js` passes after `npm run build --silent`; `npm run check:workflow` passes; the explicit recursive digest before/after a second `npm run sync:workflow` is identical.

### Slice 2 - Verified workflow generation and attempt snapshots

- [x] Add failing public-seam tests for strict manifest parsing, full-tree verification, generation hash binding, package-version independence, source mutation after pin, unsafe policy, and no ambient fallback.
- [x] Implement `src/v2/workflow-assets.ts` with exact-schema validation, closure/reference/profile/operation cross-checks, package-source verification, immutable atomic materialization, concurrent-winner reconciliation, and strict existing-destination verification.
- [x] Refactor `src/v2/runtime-assets.ts` to copy the selected operation closure from one verified generation into an immutable attempt snapshot while recording generation hash, operation, entrypoint, schema, profile, file evidence, owner, and modes.
- [x] Update `candidate-cli`, `RunRecordV1`, `RunIssue`, `createV2Runtime`, and `prepareContainedAttempt` so a new run materializes/persists one receipt before the first attempt, every implementation/rework/proof call receives it, and resume verifies the pinned root without reading current package workflow bytes. Fail closed for every nonterminal V1 record; retain terminal V1 history.
- [x] Thread the selected operation policy through `CodexProcess`; reject caller widening and prove current implementation/proof sandbox, cwd class, network/tool denial, shared-auth handling, and Runner postconditions match the manifest.
- [x] Preserve current visible V2 behavior for `agent-auto` and `acceptance-proof`; this slice changes provenance and pinning only.

### Slice 2 Exit Gate

- [x] Focused workflow/run/runtime/package-consumer tests pass, including process restart plus package replacement during an active pinned run, nonterminal/terminal V1 behavior, concurrent publication, separate generation and attempt child-process death matrices, corrupt destination, effective-policy widening negatives, conflicting HOME skills, and clean packed consumer inventory.

### Early Review Checkpoint

- [x] Run high-profile `$code-review` on Slices 1-2 with focus on source-of-truth duplication, manifest canonicalization, path traversal/symlink races, TOCTOU source drift, hash/mode/owner verification, fsync/rename ordering, generation/attempt crash recovery, concurrent publishers, immutable reuse, V1 fail-closed behavior, effective sandbox policy, and authority escalation; repair and verify all high/critical findings before Slice 3.

### Slice 3 - Package authority and clean-consumer contract

- [x] Add failing policy tests that reject nonempty MCP/network/external-write/publication authority and unapproved writable roles; keep implementation roles worktree-only and all reviewers/triage/ambiguity roles read-only.
- [x] Extend ordinary manifest/policy and packed-consumer tests (not the authenticated containment canary) to prove empty HOME and adversarial conflicting local skills cannot affect loaded inventory, profiles, operation entrypoints, or generation hash.
- [x] Update package files/scripts, `prepack`, release workflow, and bounded docs; prove tarball includes `internal-workflow`, production CLI initializes from it, and no runtime caller reads `internal-skills`.

### Slice 3 Exit Gate

- [x] `npm run check:workflow`, focused containment/package tests, and `npm pack --dry-run --json` prove one public workflow inventory with no undeclared or ambient assets.

## 7. Implementation Review State

- **Authority Artifact Kind:** approved-spec
- **Authority Artifact Path:** `docs/implementation-specs/2026-07-17/1534-issue-1226-package-workflow-closure.md`
- **Profile:** high
- **Artifact Review History:** two fresh Full sessions plus six same-session Closures. A `019f6ff7-b3ae-75e1-9a05-b1b03bdd4263` verified `NEW-ARCH-01..10`; B `019f6ff7-b478-7911-8853-ec619293b4f7` verified `NEW-CONTRACT-01..11`. Final settled revision is Approved on both axes.
- **Review Plan:** high profile. Early Full checkpoint after the first stateful generation/attempt contract: two fresh `reviewer_deep` sessions in parallel, correctness lens and spec/standards lens. Final gate: one `reviewer_standard` cleanup Full, then two fresh `reviewer_deep` code-review sessions on the settled full diff. Closure is same-session and affected-lens only. Terminal condition is no open blocker/execution-risk defects.
- **Activations:** Early correctness/spec Full and Closure waves completed with all `EARLY-*` IDs verified. Final cleanup Full plus Closure verified `CLEAN-01..02`. Final correctness and spec/standards Full reviews plus affected-lens Closures verified `FINAL-CORR-001..002` and `FINAL-SPEC-001..003`. All activations are closed.
- **Implementation Pass History:** Slice 1 importer/route closure GREEN. Slice 2 immutable generation/attempt publication, lazy run-level pin, profile/policy launch, typed V1 migration, full nine-boundary crash matrices, strict canonical manifest validation, pre-mutation ancestor-symlink rejection, descriptor-bound no-follow reads, process-start owner identity, and claim-chain validation GREEN. Slice 3 clean packed consumer/package/docs GREEN. Final validation: workflow sync/check/verify GREEN at generation `3611d258ea8c0b9e632f0d90664f6718ee47f0fa42b7a058fb9b09a9d72c3a97`; typecheck/build GREEN; deterministic suite 170/170 before final localized publisher cleanup; post-repair asset suites 11/11, importer 3/3, and 16-way concurrency regression GREEN; diff check GREEN; dry-run tarball 228 entries and package consumer GREEN.
- **Defect Ledger:** Every `EARLY-*`, `CLEAN-*`, `FINAL-CORR-*`, and `FINAL-SPEC-*` ID is independently verified. No blocker, execution-risk, or cleanup defect remains open.

## 8. Validation And Done Criteria

- [x] **Lint/Format:** Not applicable; no lint script is configured. Run `git diff --check`.
- [x] **Typecheck:** `npm run typecheck`.
- [x] **Tests:** `npm test` plus focused RED/GREEN commands recorded per slice.
- [x] **Architecture Check:** No dedicated script is configured; review `docs/deep-dive.md`, `docs/adr/0001-runner-owned-loop-policy.md`, and the package/runtime ownership diff.
- [x] **Package Proof:** maintainer-side `npm run check:workflow`, source-free `npm run verify:workflow`, CI/prepack enforcement, and `npm pack --dry-run --json` with exact generated inventory assertions.
- [x] **Live/Manual Validation:** Not applicable for AFK completion; `npm run smoke:live` is explicitly skipped because the ticket excludes live GitHub mutation.
- [x] **Behavior Proof:** production CLI and clean packed consumer with empty HOME/conflicting local skills load the exact manifest/profiles; one run keeps one generation across package replacement and restart; migration/tamper/process-death/race/authority negatives fail exactly as specified.
- [x] **Reviews:** Early high-risk code-review checkpoint, final `$cleanup-review`, and final `$code-review` converge with no open blocker/execution-risk defects.
- [x] **Final Reconciliation:** Every #1226 acceptance criterion maps to a green test/proof or an explicit blocked note; no sibling ticket behavior is implemented.

## 9. Halt Conditions

- [ ] Stop if a selected source skill requires dynamic network/plugin/MCP loading or a personal path that cannot be removed without changing its contract.
- [ ] Stop if run generation pinning would require introducing triage/route lifecycle states owned by #1227; #1226 may change only the receipt field, migration, and attempt inputs.
- [ ] Stop if preserving the current Acceptance Proof entrypoint would change its semantics rather than only its asset provenance.
- [ ] Stop if atomic immutable reuse cannot distinguish a valid concurrent winner from a corrupt pre-existing destination.

## 10. Final Action

- [ ] Return structured completion evidence to the root tickets integrator. The root, never a contained package process, creates the focused #1226 commit and performs marker-idempotent GitHub comment/close delivery before starting #1227.

## Defect Closure Notes

- **Review Summary:** eight usable passes: two high-profile Full reviews and six same-session affected-lens Closures across two fresh independent sessions.
- [x] `NEW-ARCH-01..10` and `NEW-CONTRACT-01..11` are independently verified.
- **Open Defects:** None.
- **Implementation Review Summary:** cleanup and both final code-review lenses converged; every stable implementation defect ID is verified on the settled diff.
