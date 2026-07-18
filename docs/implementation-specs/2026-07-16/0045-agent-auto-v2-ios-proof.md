---
title: "Codex Orchestrator v2 Spec 5: runner-created iOS Simulator proof"
created_at: "2026-07-17T00:45:00+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "complete"
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
| No iOS report passes without an exact active runner-created Simulator lease. | public `AcceptanceProof` iOS report without/mismatched lease | green |
| Acquire refuses any pre-existing booted Simulator and creates a new device only after durable proof-bound intent. | fake `simctl` acquisition/intent matrix | green |
| Every boot/install/launch/bind/capture/release command uses the recorded UDID; aliases and target drift fail closed. | exact argv/identity matrix | green |
| Active foreign leases and live owners cannot be reclaimed; expired dead leases clean only their recorded runner-created device. | lease expiry/owner/stale cleanup matrix | green |
| iOS pass requires screenshot, XCUITest hierarchy, process-scoped log, final state, criterion mapping, and layout/copy analysis. | generated schema/runtime iOS matrix | green |
| Wrong UDID/bundle/process, stale evidence, screenshot-only, secret/path text, and local evidence publication cannot pass or enter the receipt. | artifact/lease negative matrix | green |
| Snapshot contains iOS procedure/helper and detects either source changing during publication. | runtime-asset source-race test | green |
| A real runner-created Simulator runs the fixture through accessibility-selected XCUITest interaction and production `AcceptanceProof`, then is safely deleted. | explicit real iOS proof gate | green |
| Browser/Android/non-visual behavior and public proof/receipt shapes remain unchanged. | regression and Interface-shape tests | green |

## 5. Execution Slices

### Progress Discipline

- [x] Begin every behavior slice with focused RED evidence and preserve the observed reason.
- [x] Use `flutter-ios-debug` for real Simulator lifecycle and evidence; preserve all user-owned runtime state.
- [x] Keep UDID, process/bundle identity, lease token, raw logs, and local paths out of public results and committed docs.
- [x] Never push; commit only after the real Simulator gate and full validation pass.

### Slice 1 — Runner-created Simulator lease

- [x] **Test/Proof First:** Add RED create/bind/verify/release matrices for booted-user-session refusal, exact runtime/device type, durable pre-create intent, target drift, wrong app/process, active foreign owner, dead+expired recovery, partial create, and release crash boundaries.
- [x] Implement the iOS helper and runner verifier/release Adapter. Persist intent before `simctl create`; store only the created UDID; reject `booted`; make shutdown/delete reconciliation exact and idempotent.
- [x] Add iOS procedure/helper to the immutable package snapshot and supply exact proof-bound helper/root/artifact/xcrun/runtime/device-type parameters to the contained proof process.
- [x] **Exit Gate:** lease/runtime-asset focused tests, typecheck, architecture scan, and diff check pass.

### Slice 2 — iOS report and artifact custody

- [x] **Test/Proof First:** Add RED iOS reports for missing/mismatched lease, wrong UDID/bundle/process, screenshot-only, missing hierarchy/log/layout/copy, stale writes, secret-bearing logs, and raw target data in receipt.
- [x] Extend the generated visual schema with one exact iOS branch using local-only hierarchy/log/lease artifacts and the existing sanitized screenshot receipt.
- [x] Verify iOS ownership in `AcceptanceProof`, retain report-repair custody, and release only after terminal state; preserve all settled platform branches.
- [x] **Exit Gate:** schema parity, focused proof/artifact/lease tests, browser and Android real-contract regressions, and Interface-shape tests pass.

### Self-Check Checkpoint — unleased Simulator mutation

- [x] Root hunts `booted` aliases, existing-device selection, pre-lease create/boot, arbitrary delete, stale lease theft, broad logs, process drift, report-repair bypass, target identifiers in receipts/docs, and release before settlement. Independent review remains `Waived`.

### Slice 3 — Real accessibility-driven fixture

- [x] Create a unique temporary Simulator only through the immutable helper; record runner ownership and verify the pre-existing Simulator remains shutdown and untouched.
- [x] Copy the shared fixture to a temporary project, generate iOS platform files, add a temporary XCUITest target with Ruby `xcodeproj`, and build only for the leased UDID.
- [x] Boot/install through exact UDID, run XCUITest, select the control by accessibility label, capture pre/final `XCUIApplication.debugDescription`, and hold the final state long enough to bind/reverify the exact fixture process.
- [x] Capture fresh Simulator PNG and process-scoped logs, redact/scan, visually inspect, and submit all exact evidence through production `AcceptanceProof`.
- [x] Verify release removes the external lease and deletes only the runner-created Simulator; verify the original shutdown Simulator is unchanged; remove temporary project/evidence.
- [x] **Exit Gate:** real iOS proof GREEN without skip, focused/full tests, typecheck, package dry-run, architecture scan, containment canary, and diff check pass.

## 6. Halt Conditions

- [x] Stop before mutation if any Simulator is booted or Flutter/VM Service/IDE ownership is ambiguous.
- [x] Stop if the helper cannot create a separate device before boot/install, or cleanup cannot prove exact runner ownership.
- [x] Stop if evidence requires guessed coordinates, screenshot-only proof, broad unredacted logs, or an unleased `simctl` mutation.
- [x] Stop if iOS support requires changing `proveChange`, exposing raw target state, or importing old runtime code into `src/v2`.

## 7. Validation And Done Criteria

- [x] Every ledger row is GREEN.
- [x] Actual accessibility-driven runner-created Simulator evidence passes and the final screenshot is visually inspected; no iOS branch is skipped.
- [x] Existing shutdown Simulator and all user-owned runtime state remain unchanged.
- [x] Android/browser/non-visual regressions and unchanged Interface-shape tests remain GREEN.
- [x] Focused V2 tests, full tests, `npm run typecheck`, package dry-run, architecture scan, containment canary, and `git diff --check` pass.
- [x] Independent review remains `Waived`; root self-check defects are fixed and affected/full validation rerun.
- [x] Master links this spec and authorizes Spec 6 only after reconciliation.

## 8. Implementation Review State

- **Profile:** high.
- **Plan:** Independent artifact/checkpoint/cleanup/final review waived. Root executes exact Simulator-ownership self-check and the actual XCUITest proof.
- **Pass History:** Independent passes: none; outcome `Waived`. Root self-check covered lease intent, exact Simulator/app/process identity, artifact freshness/redaction, immutable assets, release replay, and the real XCUITest lifecycle.
- **Verified Defects:** Root self-check fixed iOS 26 process observation by replacing unavailable in-Simulator `ps` with exact bundle-scoped `launchctl` identity, made the temporary UI-test target deterministic, merged duplicate accessibility nodes, selected the newest Pro device type, and rejected an early partially rendered screenshot before final proof acceptance.
- **Accepted Risks:** `S5-REVIEW-WAIVER-001` — independent review omitted by user instruction. Shared Codex auth/user-readable host files remain accepted; Simulator lifecycle and publication authority do not.
- **Open Defects:** None.

### 8.1 Execution Evidence

- **Implementation Outcome:** GREEN. The generated proof contract has one exact iOS branch requiring a verified lease, screenshot, accessibility hierarchy, PID-scoped redacted log, current-attempt writes, criterion mapping, and evidence-linked layout/copy analysis while `proveChange(...)` and `ProofReceipt` remain unchanged.
- **Lease Outcome:** GREEN. Acquisition refuses booted sessions and live foreign ownership, persists pre-create intent, creates a separate target, binds exact bundle/PID through the leased UDID, reclaims only expired dead ownership, and makes shutdown/delete plus local/external lease settlement crash-replayable.
- **Real iOS Outcome:** GREEN. The shared fixture passed analyze/widget tests and accessibility-selected XCUITest on a fresh runner-created Simulator. The exact accepted 1206×2622 PNG was visually inspected after render stabilization; final hierarchy, redacted process log, and active lease passed production `AcceptanceProof`. Each bounded failed gate attempt was exactly released before retry; the final target was deleted, the pre-existing Simulator inventory remained unchanged and shutdown, and all temporary gate data was removed.
- **Immutable Package Outcome:** GREEN. Acceptance-proof snapshots include the iOS procedure/helper and fail closed if either source changes during resolution. Runtime discovery is read-only and selects the newest available iOS runtime and Pro iPhone device type; release tests assert exact argv and absent-target replay.
- **Validation:** Focused affected suite `28/28`; V2 suite `96/96`; repository suite `806/806`; no skip. `npm run typecheck`, `git diff --check`, architecture import scan, 521-file package dry-run inventory, and real `npm run test:v2-containment` all exit `0`.
- **Skipped Live Gates:** Live GitHub mutation, daemon operation, authenticated external services, package publication, Setup, operational consumers, and public cutover remain outside Spec 5.
- **Checkpoint Commit:** `488d456` — iOS report/lease custody, immutable procedure/helper, runtime discovery/release, shared fixture XCUITest harness, and self-check fixes.

## 9. Final Action

Completed: runner-created iOS proof, exact evidence custody, accessibility-driven XCUITest execution, visually inspected final PNG, safe target deletion, immutable package assets, and the unchanged public Interface are GREEN. The master may authorize Spec 6 next.
