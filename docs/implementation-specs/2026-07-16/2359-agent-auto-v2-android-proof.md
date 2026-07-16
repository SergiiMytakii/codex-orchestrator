---
title: "Codex Orchestrator v2 Spec 4: runner-leased Android proof"
created_at: "2026-07-16T23:59:00+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "Android proof must never install, launch, stop, or drive an unleased/user-owned device session."
  - "A visual pass must bind screenshot, UI hierarchy, redacted logcat, app identity, and lease identity without changing the public AcceptanceProof Interface."
review_outcome: "Waived"
review_verdict: "Not run; independent artifact and code review waived by user"
review_coverage: "Root executable self-checks cover lease ownership, exact serial/app pinning, stale recovery, artifact redaction, real emulator evidence, and Interface stability"
approved_content_sha256: "bae5d584387d4ae36b81c380612e33d8e7c770c9350db2fb96361a9e2a4d042f"
source_plan_sha256: "e6dd64cdc7dbd3bec1c2734782b314443335822e8523591758230c71c6d2f6aa"
---

## 1. Execution Context

- **Goal:** Extend the settled visual proof contract with runner-leased Android evidence and prove a real fixture workflow on an isolated emulator through the unchanged `AcceptanceProof.proveChange(...)` Interface.
- **Precondition Evidence:** On 2026-07-16 `adb devices` showed no targets; process inspection showed no emulator, `flutter run`, VM Service, or IDE-owned mobile session; AVD `Pixel_9_API_Baklava`, Flutter `3.44.3`, adb `36.0.0`, emulator `36.1.9`, Android platforms/build tools, and the required arm64 system image are installed.
- **Approved Scope:** Immutable Android procedure and lease helper; exact emulator serial/app identity; lease acquire/verify/release and stale recovery; user-owned-session refusal; UI hierarchy, PNG screenshot, redacted scoped logcat, layout/copy review, criterion mapping, current-attempt freshness, local-only lease/hierarchy/log artifacts; actionable external-tool blocker; one real runner-owned fixture cold start.
- **Out of Scope:** Physical devices, user-owned/live app takeover, arbitrary app installation, iOS, external authenticated services, GitHub live smoke, daemon, Setup, public cutover, package publication.
- **Authorization:** The user's instruction to finish the approved root spec authorizes a fresh isolated fixture run required by this child spec. It does not authorize replacing or terminating a user-owned process; discovery found none.
- **Simplest Viable Path:** Let the proof agent choose the Android surface, but require it to acquire the exact target through an immutable package lease helper before any adb action. `AcceptanceProof` verifies the active external lease plus local lease artifact, validates evidence, persists the typed outcome, and releases only its matching token.

## 2. Risk Controls

- **Stable Interface:** No device, serial, lease, app ID, screenshot path, or platform Adapter parameter is added to `proveChange`; raw mobile state remains private.
- **Lease Authority:** A package-owned helper selects only an online emulator, rejects physical devices and ambiguous targets, checks boot completion and current foreground/PID ownership, atomically acquires one proof-bound lease outside the worktree, and returns an exact `ANDROID_SERIAL`. No unleased adb fallback is permitted by the procedure or report validator.
- **Session Preservation:** Any pre-existing app PID, Flutter VM Service, IDE debug adapter, or visible app on the selected target is user-owned and blocks install/relaunch. The real gate uses a newly launched runner-owned AVD and records its emulator PID/serial before fixture installation.
- **Evidence Minimum:** Android pass requires an active verified lease, exact app ID/PID/serial, final workflow state, screenshot plus UI hierarchy, scoped redacted logcat, evidence-linked layout/copy analysis, criterion mapping, and artifacts written during the current proof.
- **Artifact Policy:** Screenshot may be publishable after PNG/size checks. Lease record, UI hierarchy, and logs remain local-only and are scanned/redacted. `ProofReceipt` exposes no serial, app ID, PID, lease token, or local path.
- **Lifecycle Safety:** Release is token-safe and occurs only after process/evidence/store settlement. Crash leaves a stale lease that can be reclaimed only after owner absence and exact expiry/target checks.

## 3. Confirmed Targets And Contracts

- `src/v2/mobile-lease.ts` — minimal Android lease record/store/helper Adapter; no proof semantic decisions.
- `src/v2/proof-report.ts` and `src/v2/acceptance-proof.ts` — Android visual branch, lease verification, hierarchy/log artifact policy, and unchanged sanitized receipt.
- `src/v2/runtime.ts` — concrete lease root/verification/release composition and contained proof environment; no routing in `RunIssue`.
- `internal-skills/acceptance-proof/references/android.md` and `tools/android-lease.mjs` — immutable Android procedure and executable lease entrypoint snapshotted with the skill/schema.
- `src/v2/runtime-assets.ts` — recursively snapshots/verifies Android procedure/tool bytes and catches package-update races.
- `test/fixtures/v2-mobile-fixture/` — small shared Flutter UI source copied into a generated temporary platform project for real gates.
- `test/v2-android-proof.test.ts`, existing V2 proof/report/runtime-asset tests, and one explicit real-emulator command — unit/contract and actual device evidence.

## 4. Contract Test Ledger

| Invariant | First RED proof | Status |
| --- | --- | --- |
| The proof agent can select Android, but evidence cannot pass without an exact active runner lease created before mobile actions. | public `AcceptanceProof` Android report without/mismatched lease | planned |
| Lease acquisition selects one online emulator, pins serial/app/proof/owner/expiry, and rejects physical, offline, ambiguous, or user-owned live sessions. | lease Adapter matrix | planned |
| Release and stale recovery are token-safe; active/live foreign leases cannot be reclaimed. | lease crash/expiry/owner matrix | planned |
| Android pass requires screenshot, UI hierarchy, scoped device log, final state, criterion mapping, and evidence-linked layout/copy review. | generated schema/runtime visual matrix | planned |
| Screenshot alone, wrong serial/app/PID, stale hierarchy/log, unredacted secret/path text, or missing lease cannot pass or enter the receipt. | artifact/lease negative matrix | planned |
| Immutable package snapshot contains Android procedure/helper and detects source races. | runtime-asset snapshot test | planned |
| A real runner-owned emulator executes the changed fixture workflow with exact `ANDROID_SERIAL`, stable fixture PID, UI-tree-derived interaction, screenshot, hierarchy, and redacted logcat. | explicit real Android proof gate | planned |
| Public `proveChange` and sanitized `ProofReceipt` shapes remain unchanged. | Interface-shape test | planned |

## 5. Execution Slices

### Progress Discipline

- [ ] Begin every behavior slice with a focused RED test and preserve its observed reason.
- [ ] Use `flutter-android-debug` plus `test-android-apps:android-emulator-qa` for actual emulator lifecycle/navigation/evidence.
- [ ] Keep emulator serial, PID, app ID, lease token, raw logs, and local artifact paths out of public results and committed docs.
- [ ] Never push; commit only after the real gate and full validation pass.

### Slice 1 — Lease authority and immutable package procedure

- [ ] **Test/Proof First:** Add RED matrices for one emulator, ambiguous/offline/physical targets, user-owned app PID, active foreign lease, stale owner, expiry, token-safe release, and helper source race.
- [ ] Implement the narrow lease record/store and executable package helper; persist intent before target use and verify exact target state on acquire/reuse/release.
- [ ] Add Android procedure/tool to the atomically published acceptance-proof snapshot and pass only proof-bound lease root/identity to the contained process.
- [ ] **Exit Gate:** lease/runtime-asset focused tests, typecheck, architecture scan, and diff check pass.

### Slice 2 — Android visual report and custody

- [ ] **Test/Proof First:** Add RED Android reports for missing/mismatched lease, wrong app/serial/PID, screenshot-only, missing hierarchy/log/layout/copy, stale evidence, secret-bearing logs, and raw lease data in receipt.
- [ ] Extend the one generated visual schema with an exact Android branch and local-only `ui-hierarchy`, `device-log`, and `lease-record` artifact kinds.
- [ ] Verify the active lease and evidence metadata inside `AcceptanceProof`; release matching lease only after durable terminal state and no pending proof process/artifact writes.
- [ ] Preserve the browser and non-visual branches and the public Module Interface.
- [ ] **Exit Gate:** generated-schema parity, focused proof/lease/artifact tests, browser regression fixture, and Interface-shape tests pass.

### Self-Check Checkpoint — unleased or destructive mobile path

- [ ] Root hunts direct/unleased adb fallback, device auto-selection after acquire, physical-device acceptance, lifecycle replacement, stale lease theft, token leakage, broad logcat, missing PID checks, report-repair custody bypass, and release before settlement. Independent review remains `Waived`.

### Slice 3 — Real runner-owned Android fixture

- [ ] Launch the unused installed AVD as a runner-owned cold-start session on an isolated serial; record emulator PID and verify no prior app/runtime owner.
- [ ] Copy the fixture source to a temporary directory, generate Android platform files, build/install only the fixture, resolve its activity, launch it, and record package PID/variant.
- [ ] Acquire the package lease, dump/summarize the UI tree, derive the interaction target from the tree, interact, and re-check the same fixture PID.
- [ ] Capture final UI hierarchy, screenshot, and PID-scoped logcat; redact/scan and visually inspect the screenshot.
- [ ] Submit exact evidence through `AcceptanceProof`, release the matching lease, then shut down only the runner-owned emulator process and remove temporary fixture/artifacts.
- [ ] **Exit Gate:** real proof GREEN with no skipped branch, focused/full tests, typecheck, pack dry-run, architecture scan, containment canary, and diff check pass.

## 6. Halt Conditions

- [ ] Stop before mutation if any target/app/runtime appears user-owned or discovery is ambiguous.
- [ ] Stop if only a physical device, mocked screenshot, guessed coordinate, broad unredacted log, or unleased adb path is available.
- [ ] Stop if exact Android support requires changing `proveChange`, exposing raw lease/platform fields in `ProofReceipt`, or importing the old runtime into `src/v2`.
- [ ] Stop if the runner-owned emulator PID/serial or fixture PID changes unexpectedly; do not silently relaunch.

## 7. Validation And Done Criteria

- [ ] Every ledger row is GREEN.
- [ ] Actual runner-owned emulator evidence exists and the final screenshot is visually inspected; no mobile gate is skipped.
- [ ] Browser/non-visual regressions and unchanged Interface-shape tests remain GREEN.
- [ ] Focused V2 tests, full tests, `npm run typecheck`, package dry-run, architecture scan, containment canary, and `git diff --check` pass.
- [ ] Independent review is recorded as `Waived`; root self-check defects are fixed and affected/full validation rerun.
- [ ] Master links this spec and authorizes Spec 5 only after reconciliation.

## 8. Implementation Review State

- **Profile:** high.
- **Plan:** Independent artifact/checkpoint/cleanup/final review waived. Root executes lease/destructive-path self-check and actual emulator proof.
- **Pass History:** None; outcome `Waived`.
- **Verified Defects:** None.
- **Accepted Risks:** `S4-REVIEW-WAIVER-001` — independent review omitted by user instruction. Shared Codex auth/user-readable host files remain accepted; mobile lifecycle and publication authority do not.
- **Open Defects:** None.

## 9. Final Action

Reconcile this spec and master with exact lease/real-emulator/test evidence and commits. Author Spec 5 only after Android proof is GREEN and the runner-owned emulator has been safely released.
