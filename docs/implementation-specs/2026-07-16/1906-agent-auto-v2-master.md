---
title: "Codex Orchestrator v2 agent:auto master implementation spec"
created_at: "2026-07-16T19:06:37+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "The program changes durable run/proof ownership, retry and idempotency, credential containment, and GitHub publication; an ordering error can duplicate external effects or publish unproved work."
  - "Eight sequential delivery specs span package assets, Codex process execution, browser/mobile proof, setup cutover, live GitHub smoke, and deletion of the old runtime."
review_outcome: "Waived"
review_verdict: "Shared-Codex-auth risk revision self-checked; independent re-review waived by user"
review_coverage: "Original architecture reviews remain recorded; the 2026-07-16 risk revision and continued Spec 1 execution use user-authorized self-check only"
approved_content_sha256: "8610c29fdb647029c891f6ec4755e4a907c4415f4c0ffde4d55919c8d2144011"
source_plan_sha256: "e6dd64cdc7dbd3bec1c2734782b314443335822e8523591758230c71c6d2f6aa"
---

## 1. Execution Context

- **Goal:** Deliver the approved agent:auto-only v2 rewrite through eight sequential, independently reviewed implementation specs without allowing a later slice to redefine the three approved Module Interfaces.
- **Source Material:** The approved plan at `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md` is the architectural and product authority. This master spec owns sequencing and cross-spec gates only.
- **Approved Scope:** The ten plan slices grouped into eight delivery specs: core tracer, recovery, browser proof, Android proof, iOS proof, Setup, operational consumers, and final cutover/deletion.
- **Out of Scope:** Direct code implementation from this master document; `agent:plan-auto`; issue trees; generic skill graphs; app-server transport; package-specific authentication; consumer `postinstall`; automatic config migration; automatic merge; multi-host ownership; package publication.
- **Simplest Viable Path:** One root agent executes one authorized child spec at a time. Later child specs are authored just in time from the settled implementation and this master contract. No speculative file-level instructions are written for code that does not yet exist.
- **Primary Risk:** A later spec can bypass predecessor gates, create a second owner for lifecycle/proof/setup policy, or switch the package entrypoint before the new runtime has complete proof and recovery coverage.

## 2. Decision Snapshot And Child Specs

The approved Modules and Interfaces are immutable inputs to every child spec:

- `RunIssue` exclusively owns issue lifecycle, cycle/retry policy, run-record writes, publication intents, remote observation, and reconciliation.
- `AcceptanceProof` owns proof classification/execution/recovery, proof-only state, leases, artifact custody, validation, and the sanitized `ProofReceipt` handoff.
- `Setup.execute` owns configure/prepare-labels/fresh/doctor/status policy; command handlers only parse, render, and map typed outcomes to exits.
- `proveChange` accepts only `proofId`, issue, frozen criteria, and nominal opaque `CheckedChange`.
- Shared atomic filesystem mechanics are persistence Adapters only; they never decide lifecycle, retry, proof, setup, or publication policy.

| Delivery spec | Plan slices | Authorized result | Creation / start gate |
| --- | --- | --- | --- |
| **Spec 1 — Core tracer** | 1-2 | Isolated V2 source root, package-owned skills/schemas, immutable attempt snapshots, ordinary `codex exec` containment, and fake-backed `runIssue -> AcceptanceProof -> draft PR`. | Reviewed with this master; may start after the dedicated worktree is created from `v0.1.51`. |
| **Spec 2 — Autonomous recovery** | 3 | Same-worktree rework, bounded transport/report repair, capability-separated durable state, crash resume, exact publication intents, and duplicate-effect prevention. [Spec](./2253-agent-auto-v2-autonomous-recovery.md) | Spec 1 is fully complete: checklist/ledger, containment canary, all validation, waived reviews, and final handoff are reconciled. Author from its settled Interfaces. |
| **Spec 3 — Browser proof** | 4 | Real browser workflow evidence and production-readiness analysis behind the unchanged `AcceptanceProof` Interface. | Spec 2 is fully complete, including crash/idempotency review and final validation; browser fixture/runtime are confirmed. |
| **Spec 4 — Android proof** | 5 | Runner-leased Android workflow evidence behind the unchanged proof Interface. | Spec 3 is fully complete, including its real browser evidence and final review; Android toolchain/safe lease fixture are confirmed. |
| **Spec 5 — iOS proof** | 6 | Runner-leased iOS Simulator workflow evidence behind the unchanged proof Interface. | Spec 4 is fully complete, including actual leased Android evidence and final review; iOS toolchain/safe lease fixture are confirmed. |
| **Spec 6 — Setup** | 7 | Typed `Setup.execute`, minimal first setup, byte-stable repeat, label preparation, detect-only Legacy status, and manifest-backed fresh cutover. | Spec 5 is fully complete, including actual leased iOS evidence and final review; config/state roots are settled. |
| **Spec 7 — Operational consumers** | 8-9 | Relevant live-smoke scenario migration and local self-improvement consumption of the single CLI JSON/runIssue path. | Spec 6 is fully complete, including Setup crash matrix and final review; live smoke still requires separate explicit authorization. |
| **Spec 8 — Cutover and deletion** | 10 | Public CLI/package entrypoint switch, old runtime deletion, authoritative docs/ADR updates, final package/live gates, and release-ready tarball. | Spec 7 is fully complete, including authorized relevant live smoke and self-improvement validation; every earlier spec remains reconciled. |

Specs 1 and 2 are authored in this directory. Specs 3-8 must be produced with `implementation-spec-maker`, checked against the then-current implementation, and linked into this table before their implementation starts. Independent reviews remain waived until the user changes that decision.

## 3. Repository And Branch Contract

- **Reference checkout:** `/Users/serhiimytakii/Projects/codex-orchestrator` at current `main` commit `0c876cb153c53f1bee5b08535406285d4c9899d6`; it remains reference evidence and retains the plan/master/spec artifacts.
- **Implementation base:** tag `v0.1.51`, currently `2ae87065fe70b61bd5ec09c51b2e380045f3d144`.
- **Implementation branch:** `codex/v2-agent-auto`.
- **Implementation worktree:** `/Users/serhiimytakii/Projects/codex-orchestrator-v2-agent-auto`.
- **Bootstrap command:** from the reference checkout, after confirming the branch/path still do not exist, run `git worktree add /Users/serhiimytakii/Projects/codex-orchestrator-v2-agent-auto -b codex/v2-agent-auto v0.1.51`.
- **Artifact bootstrap:** before runtime edits, copy the approved plan, this master spec, and the current child spec from their exact absolute source paths to the same repository-relative paths in the implementation worktree. Verify the plan's ordinary SHA-256 against `source_plan_sha256`. For each spec, `approved_content_sha256` means SHA-256 over bytes with the single `approved_content_sha256:` frontmatter line omitted; verify it with `awk '!/^approved_content_sha256:/' <file> | shasum -a 256`. After copying, require byte-equal source/destination with `cmp -s`. Commit only those verified copies as the branch's first docs-only checkpoint. Checklist updates then occur only in the implementation-worktree copy.
- **Protected state:** Do not modify, delete, reset, or clean the reference checkout, commit `0c876cb`, `docs/plans/2026-07-15/`, or `.codex-orchestrator/local/self-improvement/`. Do not touch the existing issue-1224 worktree.

## 4. Risk Controls

- **Source of Truth:** The approved plan owns product scope and Module Interfaces. This master owns child-spec order. Each authorized child spec owns only its implementation slice and checklist; its frontmatter records whether review was approved or waived.
- **Safety Constraints:** No live smoke, real GitHub issue/branch/PR mutation, daemon start, package publish, release, mobile session takeover, or destructive Legacy cleanup occurs without the plan's explicit gate and separate user authorization where required.
- **Accepted Local-Read Risks:** Root/native-child tool shells may read/use the same user-owned Codex auth and any local file readable by the current macOS user. This acceptance does not extend to credential/path output, GitHub/npm/SSH/cloud credentials, tool network, production commands, or runner-owned publication.
- **Contract Constraints:** A child spec may deepen private Implementation and concrete external Adapters but may not add platform/storage/device parameters to `runIssue` or `proveChange`, expose raw proof paths, or grant proof/setup code a run-record write capability.
- **Concurrency / State Constraints:** Delivery is serial and single-agent. No two child specs are implemented concurrently. One host-global repository owner remains the supported runtime model.
- **Cutover Constraint:** `src/cli.ts`, `src/index.ts`, package exports/bin, and removal of the old runtime remain unchanged until Spec 8, except package-file inclusion needed to test the parallel V2 candidate. Earlier specs test the candidate surface directly under `src/v2/`.
- **Reuse Constraint:** Port behavior and tests from the old runtime, not its orchestration architecture. A copied leaf utility is allowed only when it has no old runtime-policy dependency and passes the deletion test in its child spec.
- **Early Review Gate:** Every high-risk child spec must run `$code-review` after its first stateful/external-effect tracer slice and close high/critical findings before continuing.
- **Final Handoff Requirements:** Each child executor reports the implemented contract, checklist state, high-risk checkpoint result, invariants proved, review findings/fixes, validation, skipped live gates, residual risks, and files grouped by role. No separate report is required beyond child-spec checklist/artifacts unless that child spec requires one.

## 5. Master Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Specs execute serially and a later spec starts only after its predecessor exit gate and review checkpoint are green. | Parallel or out-of-order work redefines shared contracts and makes failures impossible to attribute. | Master checklist plus predecessor spec reconciliation before child-spec creation | planned |
| `RunIssue`, `AcceptanceProof`, `Setup.execute`, `CheckedChange`, and `ProofReceipt` retain the approved ownership and Interface shapes across all specs. | A later platform/setup/recovery slice leaks complexity into callers or creates multiple policy owners. | Interface-shape tests introduced in Spec 1 and rerun by every later spec | planned |
| The installed public bin remains on the old runtime until Spec 8, while earlier specs test an isolated V2 candidate path. | A partially implemented V2 replaces working setup/status/proof behavior before recovery/platform coverage exists. | Package bin/export snapshot before Spec 8; final cutover snapshot in Spec 8 | planned |
| Live GitHub/mobile/release effects run only at their explicit gates and never as ordinary unit-test side effects. | Spec execution mutates real repositories/devices or publishes an incomplete package. | Child-spec precondition and explicit live command record | planned |
| Final tarball contains one runtime path and no plan-auto/graph/app-server/migration compatibility surface. | Cutover ships two authorities or preserves the complexity the rewrite is intended to remove. | Spec 8 tarball inventory and public CLI/export snapshots | planned |

## 6. Master Execution Checklist

### Progress Discipline

- [x] Execute only the current authorized child spec.
- [x] Update this master table and checklist when a child spec is created, approved, completed, blocked, or superseded.
- [x] Leave future child specs unauthored until their creation gate is satisfied.
- [x] Stop when repo reality contradicts the plan, a predecessor exit gate, or an approved Interface; do not repair the contradiction by silently redesigning the next spec.
- [x] Keep each child implementation single-agent unless the user separately approves a disjoint multi-agent execution contract.

### Phase 1 — Core tracer

- [x] Execute Spec 1 at `docs/implementation-specs/2026-07-16/1907-agent-auto-v2-core-tracer.md` through its waived-review self-check and validation gates.
- **Resumed:** The user accepted shared Codex-auth and user-readable host-file exposure and waived independent review. The revised V2 canary recorded those reads while denying every tested external credential/production capability, so Slice 1 may begin.
- [x] Record the settled V2 source paths, Interface hashes/snapshots, containment result, and remaining residual risks in this master before authoring Spec 2.
- [x] Do not author or start Spec 2 until Spec 1's complete checklist, Contract Test Ledger, waived reviews, validation, and handoff are reconciled.

### Phase 2 — Autonomous recovery

- [x] Author Spec 2 from plan slice 3 and the settled Spec 1 implementation; independent artifact review is waived and executable self-check gates are recorded.
- [ ] Do not start platform work until recovery, publication idempotency, and crash-matrix checkpoints are green.

### Phases 3-5 — Browser, Android, and iOS proof

- [ ] Author each platform spec only after the immediately preceding numbered spec is fully complete; all three consume the unchanged `AcceptanceProof` Interface.
- [ ] Browser completion requires a real local fixture. Android/iOS completion requires actual runner-leased emulator/simulator evidence; mocked screenshots are insufficient.

### Phase 6 — Setup

- [ ] Author and review Setup from plan Section 2.3 and slice 7 after config/state paths settle.
- [ ] Prove config-last and matching-manifest recovery through `Setup.execute`; keep CLI handlers policy-free.

### Phase 7 — Operational consumers

- [ ] Author and review live-smoke/self-improvement adaptation after the CLI JSON contract settles.
- [ ] Run package/local tests first; run live smoke only with separate explicit authorization.

### Phase 8 — Cutover and deletion

- [ ] Author and review the final cutover spec only after every previous checklist is reconciled.
- [ ] Switch the public entrypoint once, delete superseded runtime/tests/docs, run cleanup/final code review, and prove the packed package has one authority.

## 7. Halt Conditions

- [ ] Stop if `v0.1.51`, `codex/v2-agent-auto`, or the intended worktree path resolves to a different state than Section 3.
- [ ] Stop if a child spec needs to change an approved Module owner or stable Interface rather than only its private Implementation.
- [ ] Stop if containment canaries expose runner/GitHub/npm/SSH/cloud credentials, production commands, or credential/path output to agent tools. Shared Codex auth and user-readable host files are explicitly accepted.
- [ ] Stop if a live/mobile/release gate is required but authorization or a safe environment is absent; preserve the completed local work and exact blocker.
- [ ] Stop final cutover if any prior child spec, real platform proof, relevant live smoke, cleanup review, or final code review remains incomplete.

## 8. Validation And Done Criteria

- [ ] Master table links every created child spec and records its terminal review outcome.
- [ ] Every child checklist and Contract Test Ledger is reconciled.
- [ ] Every required early `$code-review`, cleanup review, and final `$code-review` is recorded.
- [ ] The final implementation satisfies the plan's package-consumer, setup/cutover, real browser/mobile, relevant live-smoke, typecheck, full-test, `git diff --check`, and tarball gates.
- [ ] No open blocker or unaccepted execution risk remains.

## 9. Defect Closure Notes

- **Review Summary:** Two independent Full reviews and same-session affected-lens Closure approved the master sequencing and bootstrap contracts.
- [x] Every stable Defect Ledger ID is `verified`, `blocked` with a concrete reason, or explicitly accepted by the user.
- **Open Defects:** None.

| ID | Repair | Status |
| --- | --- | --- |
| `MASTER-SEQ-001` | Every Spec 2-8 now requires the full terminal/review/validation gate of its immediate predecessor. | verified |
| `MASTER-BOOT-002` | Plan/spec authority is digest-pinned and copied with canonical hash plus byte-equality checks before the docs-only branch commit. | verified |

### 9.1 Current Execution Status

- **Current Child:** Spec 2 — Autonomous recovery — authored and authorized for execution.
- **Execution Outcome:** Spec 1 completed on 2026-07-16. Spec 2 is the active child under the same shared-auth acceptance and independent-review waiver.
- **Evidence State:** The old all-false canary is historical RED evidence. The revised V2 certificate is GREEN: root/native child recorded Codex-auth and host-file readability `true`, with external credentials and production effects `false`; strict reparse matched package version and argv-policy digest.
- **Review Decision:** Independent artifact/code reviews are user-waived; the Slices 1-3 containment checkpoint and Slices 4-5 lifecycle/publication checkpoint passed executable root self-checks. Outcome remains `Waived`, not independently approved.
- **Sequencing Decision:** Spec 1's terminal gate is satisfied and Spec 2 is linked above. Specs 3-8 remain unauthored until their predecessor gates pass.

## 10. Final Action

After saving or updating this master, report the exact current child spec, its gate, review outcome, validation gates, and blockers. Do not claim the whole v2 program complete until Phase 8 is complete.
