---
title: "Codex Orchestrator v2 Spec 5: runner-created iOS Simulator proof"
created_at: "2026-07-17T00:45:00+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "iOS proof must never boot, install into, drive, or delete a user-owned Simulator session."
  - "Simulator creation/deletion and XCUITest evidence must remain proof-bound and crash-recoverable without changing the public AcceptanceProof Interface."
review_outcome: "Waived"
review_verdict: "Not run; independent artifact and code review waived by user"
review_coverage: "Root executable self-checks cover Simulator ownership, exact UDID/app/process binding, accessibility evidence, release reconciliation, redaction, and real XCUITest execution"
approved_content_sha256: "ec65610ba540a10e45bb38b6361d245521d8af9b2508909fcc96d8526124d09e"
source_plan_sha256: "e6dd64cdc7dbd3bec1c2734782b314443335822e8523591758230c71c6d2f6aa"
---

## 1. Execution Context

- **Goal:** Extend the settled visual proof contract with a runner-created iOS Simulator target and prove the shared fixture through the unchanged `AcceptanceProof.proveChange(...)` Interface.
- **Precondition Evidence:** Xcode 26.3 and `simctl` are available; iOS 26.3 runtime and iPhone 17 Pro device type are installed; one existing Simulator is shutdown; no Simulator is booted and no Flutter, VM Service, or IDE debug runtime is active. Ruby `xcodeproj` 1.27.0 is available for the temporary real-gate UI-test target.
- **Approved Scope:** Immutable iOS procedure/helper; proof-bound runner-created Simulator; exact UDID/bundle/process identity; boot/install/launch only after lease; XCUITest accessibility hierarchy and interaction; PNG screenshot; process-scoped Simulator logs; layout/copy review; current-attempt custody; release/shutdown/delete and stale recovery; one real temporary fixture.
- **Out of Scope:** Physical iOS devices, any existing user Simulator, authenticated external services, Android changes beyond regression, GitHub live smoke, Setup, public cutover, daemon, package publication.
- **Authorization:** The root instruction authorizes one fresh runner-created Simulator fixture and deletion of only that exact runner-owned device after terminal proof settlement. It does not authorize booting, changing, or deleting the existing shutdown Simulator.
- **Simplest Viable Path:** The package helper acquires one global iOS lease before creating a uniquely proof-bound Simulator from runner-supplied runtime/device-type IDs. The proof agent may operate only on the returned UDID. `AcceptanceProof` verifies external/local ownership and evidence, persists a terminal result, then the runner release Adapter reconciles shutdown/delete and lease removal.

## 2. Risk Controls

- **Stable Interface:** No platform, UDID, bundle ID, process ID, target, screenshot path, or lease field enters `proveChange` or `ProofReceipt`.
- **Session Preservation:** Any booted Simulator before acquisition blocks iOS leasing. The helper never selects the existing shutdown device; it creates a new device after durable lease intent and records `runnerCreated: true` plus exact UDID.
- **Exact Target:** Every `simctl` mutation uses the leased UDID. Bind verifies the exact bundle container and process. Evidence capture re-verifies the same device/app/process; no `booted` alias or post-acquire auto-selection is allowed.
- **Evidence Minimum:** iOS pass requires active verified lease, final workflow state, fresh screenshot plus XCUITest accessibility hierarchy, process-scoped redacted log, criterion mapping, and evidence-linked layout/copy analysis.
- **Lifecycle Safety:** Release starts only after proof-process quiescence, evidence validation, and durable terminal store settlement. It reconciles already-shutdown/deleted runner targets, never deletes an unrecorded device, writes local `released`, removes the external lease durably, and supports crash replay.
- **Artifact Policy:** Screenshot alone is insufficient. Hierarchy, logs, and lease stay local-only and receive the existing UTF-8/secret/path scan. The receipt exposes only safe screenshot identity/hash/description.

## 3. Confirmed Targets And Contracts

- `src/v2/mobile-lease.ts` — add iOS lease record/verifier/release Adapter beside Android, with exact platform-specific parsing and no proof semantic decisions.
- `src/v2/proof-report.ts` and `src/v2/acceptance-proof.ts` — add exact iOS visual branch and lease selection while preserving browser/Android/non-visual behavior and public shapes.
- `src/v2/runtime.ts` — pass proof-bound iOS helper/root/artifact/xcrun/runtime/device-type inputs and compose exact release reconciliation; no routing in `RunIssue`.
- `internal-skills/acceptance-proof/references/ios.md` and `tools/ios-lease.mjs` — immutable no-fallback procedure and executable create/bind/verify lease entrypoint.
- `src/v2/runtime-assets.ts` — include and race-check iOS procedure/helper in the immutable snapshot.
- `test/fixtures/v2-mobile-fixture/` — reuse the shared Flutter UI; add only fixture-owned temporary XCUITest configuration/source needed for accessibility-driven real proof.
- `test/v2-ios-lease.test.ts`, `test/v2-ios-proof.test.ts`, report/runtime-asset regressions, and `test/v2-ios-real-gate.ts` — contract and actual Simulator evidence.

## 4. Contract Test Ledger

| Invariant | First RED proof | Status |
| --- | --- | --- |
| No iOS report passes without an exact active runner-created Simulator lease. | public `AcceptanceProof` iOS report without/mismatched lease | planned |
| Acquire refuses any pre-existing booted Simulator and creates a new device only after durable proof-bound intent. | fake `simctl` acquisition/intent matrix | planned |
| Every boot/install/launch/bind/capture/release command uses the recorded UDID; aliases and target drift fail closed. | exact argv/identity matrix | planned |
| Active foreign leases and live owners cannot be reclaimed; expired dead leases clean only their recorded runner-created device. | lease expiry/owner/stale cleanup matrix | planned |
| iOS pass requires screenshot, XCUITest hierarchy, process-scoped log, final state, criterion mapping, and layout/copy analysis. | generated schema/runtime iOS matrix | planned |
| Wrong UDID/bundle/process, stale evidence, screenshot-only, secret/path text, and local evidence publication cannot pass or enter the receipt. | artifact/lease negative matrix | planned |
| Snapshot contains iOS procedure/helper and detects either source changing during publication. | runtime-asset source-race test | planned |
| A real runner-created Simulator runs the fixture through accessibility-selected XCUITest interaction and production `AcceptanceProof`, then is safely deleted. | explicit real iOS proof gate | planned |
| Browser/Android/non-visual behavior and public proof/receipt shapes remain unchanged. | regression and Interface-shape tests | planned |

## 5. Execution Slices

### Progress Discipline

- [ ] Begin every behavior slice with focused RED evidence and preserve the observed reason.
- [ ] Use `flutter-ios-debug` for real Simulator lifecycle and evidence; preserve all user-owned runtime state.
- [ ] Keep UDID, process/bundle identity, lease token, raw logs, and local paths out of public results and committed docs.
- [ ] Never push; commit only after the real Simulator gate and full validation pass.

### Slice 1 — Runner-created Simulator lease

- [ ] **Test/Proof First:** Add RED create/bind/verify/release matrices for booted-user-session refusal, exact runtime/device type, durable pre-create intent, target drift, wrong app/process, active foreign owner, dead+expired recovery, partial create, and release crash boundaries.
- [ ] Implement the iOS helper and runner verifier/release Adapter. Persist intent before `simctl create`; store only the created UDID; reject `booted`; make shutdown/delete reconciliation exact and idempotent.
- [ ] Add iOS procedure/helper to the immutable package snapshot and supply exact proof-bound helper/root/artifact/xcrun/runtime/device-type parameters to the contained proof process.
- [ ] **Exit Gate:** lease/runtime-asset focused tests, typecheck, architecture scan, and diff check pass.

### Slice 2 — iOS report and artifact custody

- [ ] **Test/Proof First:** Add RED iOS reports for missing/mismatched lease, wrong UDID/bundle/process, screenshot-only, missing hierarchy/log/layout/copy, stale writes, secret-bearing logs, and raw target data in receipt.
- [ ] Extend the generated visual schema with one exact iOS branch using local-only hierarchy/log/lease artifacts and the existing sanitized screenshot receipt.
- [ ] Verify iOS ownership in `AcceptanceProof`, retain report-repair custody, and release only after terminal state; preserve all settled platform branches.
- [ ] **Exit Gate:** schema parity, focused proof/artifact/lease tests, browser and Android real-contract regressions, and Interface-shape tests pass.

### Self-Check Checkpoint — unleased Simulator mutation

- [ ] Root hunts `booted` aliases, existing-device selection, pre-lease create/boot, arbitrary delete, stale lease theft, broad logs, process drift, report-repair bypass, target identifiers in receipts/docs, and release before settlement. Independent review remains `Waived`.

### Slice 3 — Real accessibility-driven fixture

- [ ] Create a unique temporary Simulator only through the immutable helper; record runner ownership and verify the pre-existing Simulator remains shutdown and untouched.
- [ ] Copy the shared fixture to a temporary project, generate iOS platform files, add a temporary XCUITest target with Ruby `xcodeproj`, and build only for the leased UDID.
- [ ] Boot/install through exact UDID, run XCUITest, select the control by accessibility label, capture pre/final `XCUIApplication.debugDescription`, and hold the final state long enough to bind/reverify the exact fixture process.
- [ ] Capture fresh Simulator PNG and process-scoped logs, redact/scan, visually inspect, and submit all exact evidence through production `AcceptanceProof`.
- [ ] Verify release removes the external lease and deletes only the runner-created Simulator; verify the original shutdown Simulator is unchanged; remove temporary project/evidence.
- [ ] **Exit Gate:** real iOS proof GREEN without skip, focused/full tests, typecheck, package dry-run, architecture scan, containment canary, and diff check pass.

## 6. Halt Conditions

- [ ] Stop before mutation if any Simulator is booted or Flutter/VM Service/IDE ownership is ambiguous.
- [ ] Stop if the helper cannot create a separate device before boot/install, or cleanup cannot prove exact runner ownership.
- [ ] Stop if evidence requires guessed coordinates, screenshot-only proof, broad unredacted logs, or an unleased `simctl` mutation.
- [ ] Stop if iOS support requires changing `proveChange`, exposing raw target state, or importing old runtime code into `src/v2`.

## 7. Validation And Done Criteria

- [ ] Every ledger row is GREEN.
- [ ] Actual accessibility-driven runner-created Simulator evidence passes and the final screenshot is visually inspected; no iOS branch is skipped.
- [ ] Existing shutdown Simulator and all user-owned runtime state remain unchanged.
- [ ] Android/browser/non-visual regressions and unchanged Interface-shape tests remain GREEN.
- [ ] Focused V2 tests, full tests, `npm run typecheck`, package dry-run, architecture scan, containment canary, and `git diff --check` pass.
- [ ] Independent review remains `Waived`; root self-check defects are fixed and affected/full validation rerun.
- [ ] Master links this spec and authorizes Spec 6 only after reconciliation.

## 8. Implementation Review State

- **Profile:** high.
- **Plan:** Independent artifact/checkpoint/cleanup/final review waived. Root executes exact Simulator-ownership self-check and the actual XCUITest proof.
- **Pass History:** None; outcome `Waived`.
- **Verified Defects:** None.
- **Accepted Risks:** `S5-REVIEW-WAIVER-001` — independent review omitted by user instruction. Shared Codex auth/user-readable host files remain accepted; Simulator lifecycle and publication authority do not.
- **Open Defects:** None.

## 9. Final Action

Reconcile this spec and master with exact sanitized lease/Simulator/test evidence and commits. Author Spec 6 only after the runner-created iOS proof is GREEN and the temporary Simulator has been exactly deleted.
