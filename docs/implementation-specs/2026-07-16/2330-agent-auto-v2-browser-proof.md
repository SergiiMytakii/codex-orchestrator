---
title: "Codex Orchestrator v2 Spec 3: browser production-readiness proof"
created_at: "2026-07-16T23:30:00+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "A visual pass can incorrectly publish stale, irrelevant, screenshot-only, or secret-bearing evidence."
  - "The browser slice extends the generated Proof Report contract reused by later mobile slices while the public AcceptanceProof Interface must remain unchanged."
review_outcome: "Waived"
review_verdict: "Not run; independent artifact and code review waived by user"
review_coverage: "Root executable self-checks cover visual evidence completeness, artifact custody/redaction, real browser execution, and Interface stability"
approved_content_sha256: "f6192a78c69cacd9f08b4aedc1564ac4f95d9341e45da81ece36f27734014e61"
source_plan_sha256: "e6dd64cdc7dbd3bec1c2734782b314443335822e8523591758230c71c6d2f6aa"
---

## 1. Execution Context

- **Goal:** Prove an actual changed local web workflow through the unchanged `AcceptanceProof.proveChange(...)` Interface, with criterion-linked browser evidence that is fresh, responsive, analyzed, redacted, and safely classified for publication.
- **Source Material:** Approved plan slice 4, master spec `1906-agent-auto-v2-master.md`, completed Spec 2 `2253-agent-auto-v2-autonomous-recovery.md`, and the settled private V2 proof implementation.
- **Approved Scope:** Browser surface classification; workflow and final-state evidence; desktop and responsive viewports; PNG screenshots; DOM snapshot; console and failed-network diagnostics; explicit layout/copy findings; artifact freshness metadata; publishable/local-only classification; size/path/hash/secret scanning; package-owned browser procedure; real localhost fixture proof; negative evidence matrix.
- **Out of Scope:** Android/iOS leases and evidence; Setup; daemon/live GitHub smoke; public CLI cutover; package publication; browser authentication against a real external service.
- **Simplest Viable Path:** Extend the one generated Proof Report owner with a strict visual-evidence branch, keep browser execution as proof-agent-owned work documented by the package skill, and let `AcceptanceProof` validate artifact bytes/metadata and return only the existing sanitized `ProofReceipt`.
- **Primary Risk:** A plausible screenshot is accepted even though it is stale, unrelated to the criterion, missing runtime/DOM context, or leaks sensitive text when published.

## 2. Risk Controls

- **Source of Truth:** `proof-report.ts` owns the generated semantic contract; `AcceptanceProof` owns artifact custody/freshness/redaction validation. The package procedure explains execution but cannot relax either validator.
- **Stable Interface:** Do not add browser, viewport, scenario, artifact-path, or Adapter parameters to `proveChange`. `RunIssue` still sees only the existing typed result and sanitized receipt.
- **Evidence Minimum:** A passed browser surface requires two relevant viewport captures (desktop and narrow responsive), screenshot plus DOM evidence mapped to each browser criterion, console and network diagnostics, final workflow state, post-interaction freshness, and layout/copy findings linked to evidence.
- **Artifact Policy:** Proof files stay below the proof root, are regular bytes with exact hashes and bounded sizes, and are newer than the running proof attempt. Screenshots may be publishable only when valid PNG/JPEG and size-capped. DOM/console/network files are always local-only. Text artifacts are scanned for secret values, secret/path labels, private keys, authorization headers, and absolute user-home paths.
- **Safety Constraints:** The real proof uses an ephemeral localhost fixture and headless Chrome, performs no external authentication or network publication, and writes only temporary proof artifacts.
- **Review Decision:** Independent review remains `Waived`; root records RED/GREEN reasons and runs the named evidence-policy self-check.

## 3. Confirmed Targets And Contracts

- `src/v2/proof-report.ts` — one generated report schema and semantic validator for non-visual plus visual evidence; later mobile specs extend the same private visual contract without changing the Module Interface.
- `src/v2/acceptance-proof.ts` — artifact hash/path/type/size/freshness/redaction/publication checks and sanitized receipt creation.
- `src/v2/runtime.ts` — concrete artifact metadata inspection and a browser-capable contained proof prompt; no platform routing leaks to `RunIssue`.
- `internal-skills/acceptance-proof/SKILL.md` and `internal-skills/acceptance-proof/references/browser.md` — exact package procedure for classification, real workflow execution, artifact custody, and report-only output.
- `src/v2/runtime-assets.ts` — immutable proof snapshot includes the package procedure bytes and records their evidence.
- `test/v2-browser-proof.test.ts`, `test/v2-acceptance-proof.test.ts`, `test/v2-report-contracts.test.ts`, and packed-consumer/runtime-asset tests — public-seam, generated-schema, real fixture, and package proofs.

## 4. Contract Test Ledger

| Invariant | First RED proof | Status |
| --- | --- | --- |
| Visual classification is constrained by frozen criterion IDs and explicit target/surface mappings without changing `proveChange`. | generated-schema and public Interface-shape test | green |
| Browser pass requires an actual final workflow state, desktop and narrow viewports, screenshot plus DOM evidence, console/network diagnostics, and evidence-linked layout/copy analysis. | strict visual report matrix | green |
| Every browser artifact is hash/path/type/size checked and demonstrably created during the current proof attempt. | stale/hash/path/oversize Artifact-custody test | green |
| DOM, console, and network evidence remain local-only; only safe screenshots or sanitized summaries enter `ProofReceipt`. | publication classification test | green |
| Secret-bearing or absolute-user-path text is rejected before pass/receipt, without exposing the matched value in diagnostics. | redaction negative matrix | green |
| Irrelevant route, missing criterion mapping, one viewport, or screenshot-only evidence cannot pass. | negative browser report matrix | green |
| A real changed localhost fixture reaches its final state in headless Chrome and passes through `AcceptanceProof` with fresh screenshot/DOM/console/network evidence. | real browser tracer-bullet test | green |
| The packed immutable acceptance-proof snapshot contains the browser procedure and generated schema bytes. | runtime-asset and packed-consumer test | green |

## 5. Execution Slices

### Progress Discipline

- [x] Start each behavior with a focused failing public-seam or generated-contract test and preserve its RED reason.
- [x] Keep all browser execution and evidence policy private to `AcceptanceProof`; do not change the approved Module Interface.
- [x] Commit only after the real fixture and full validation gates pass; never push.

### Slice 1 — Generated visual evidence contract

- [x] **Test/Proof First:** Add RED schema/validator cases for the complete browser contract and for irrelevant, one-viewport, missing DOM/diagnostics/analysis, screenshot-only, duplicate, and rewritten-criterion evidence.
- [x] Extend `ProofReportV1` with one exact visual-evidence shape required only for visual decisions; preserve the existing non-visual branch.
- [x] Require criterion evidence to cover every declared surface and require browser-specific evidence categories and responsive viewport coverage.
- [x] Regenerate schema only from TypeScript and prove runtime snapshot parity.
- [x] **Exit Gate:** focused report-contract/runtime-asset tests and typecheck pass.

### Slice 2 — Artifact custody, freshness, and publication safety

- [x] **Test/Proof First:** Add RED cases for stale mtime, hash mismatch, path escape, invalid image bytes, oversize files, local diagnostic publication, secret tokens/private keys/auth headers, and absolute home paths.
- [x] Add artifact metadata inspection behind the private proof dependency and compare every visual artifact to the active proof-attempt start.
- [x] Enforce bounded type-aware bytes and local-only browser diagnostics; scan text without echoing matched secret/path material.
- [x] Keep `ProofReceipt` storage-independent and free of raw paths/content while retaining stable IDs and hashes for safe publishable evidence.
- [x] **Exit Gate:** focused `AcceptanceProof` custody/redaction tests, Interface-shape tests, and diff check pass.

### Self-Check Checkpoint — false-positive visual pass

- [x] Root self-check hunts screenshot-count logic, agent-controlled publication bypass, stale evidence acceptance, missing responsive coverage, route/criterion mismatch, secret echo in errors, raw local paths in receipt, and platform fields crossing `proveChange`. Independent review outcome remains `Waived`.

### Slice 3 — Package procedure and real browser tracer bullet

- [x] **Test/Proof First:** Add a RED package-snapshot test for the browser procedure and a RED real fixture test that changes a localhost page, navigates/interacts at desktop and narrow viewports, and submits resulting evidence through `AcceptanceProof`.
- [x] Update the acceptance-proof skill to classify browser surfaces from frozen criteria/diff, follow the exact package procedure, capture final screenshots/DOM/console/network after the last interaction, and emit only the generated report.
- [x] Snapshot procedure bytes atomically with the skill/schema so package update races cannot change the active attempt instructions.
- [x] Run the real fixture with the installed local Chrome executable and Playwright Core; assert final DOM state and non-empty PNG dimensions/signature before proof acceptance.
- [x] **Exit Gate:** real fixture GREEN, focused V2 proof suite, full tests, typecheck, pack dry-run, architecture scan, containment canary, and `git diff --check` pass.

## 6. Halt Conditions

- [x] Stop if the real localhost fixture cannot launch a safe headless browser or only mocked browser evidence is available.
- [x] Stop if browser support requires adding platform parameters to `proveChange`, raw artifact paths to `ProofReceipt`, or an old-runtime import under `src/v2`.
- [x] Stop if evidence freshness or secret scanning cannot fail closed without revealing the sensitive match.
- [x] Stop if active package procedure bytes cannot be snapshotted with the skill/schema identity.

## 7. Validation And Done Criteria

- [x] Every ledger row is GREEN through focused tests.
- [x] Real changed localhost fixture proof passes through `AcceptanceProof`; no browser test is skipped.
- [x] Public `proveChange` and `ProofReceipt` Interface-shape tests remain unchanged/green.
- [x] `npm run typecheck`, focused compiled V2 tests, full `npm test`, `npm pack --dry-run --json --ignore-scripts`, architecture scan, real containment canary, and `git diff --check` pass.
- [x] Independent cleanup/code review is recorded as `Waived`; root self-check defects are fixed and affected/full validation rerun.
- [x] Master ledger/status links this spec and authorizes Spec 4 only after all rows reconcile.

## 8. Implementation Review State

- **Profile:** high.
- **Plan:** Independent artifact, checkpoint, cleanup, and final code review waived by the user. Root executes the named evidence-policy self-check and final validation.
- **Pass History:** Independent passes: none; outcome `Waived`. Root self-check covered visual completeness, current-attempt writes, type-aware bytes, redaction, receipt sanitization, and immutable procedure publication.
- **Verified Defects:** Root self-check closed three defects before checkpoint: mtime-only freshness, truncated-PNG acceptance, and artifact-custody failures incorrectly entering report repair.
- **Accepted Risks:** `S3-REVIEW-WAIVER-001` — independent review omitted by direct user instruction; executable proof is not independent approval.
- **Open Defects:** None.

### 8.1 Execution Evidence

- **Implementation Outcome:** GREEN. The generated report contract now has exact non-visual and browser branches; browser pass requires desktop/narrow captures, screenshot plus DOM per criterion, console/network diagnostics, final workflow state, and evidence-linked layout/copy review.
- **Artifact Outcome:** GREEN. Visual artifacts require current-attempt content changes, proof-start-relative metadata, exact hashes, bounded type-aware bytes, valid PNG IHDR dimensions, UTF-8 secret/path scanning, and local-only DOM/console/network classification. The receipt contains only safe screenshot IDs/hashes/descriptions and no local paths.
- **Real Browser Outcome:** GREEN. Headless installed Chrome executed a changed ephemeral localhost dashboard fixture at `1280x720` and `390x844`, clicked through the final interaction, asserted live DOM state, captured real PNG/DOM/console/network evidence, and passed it through `AcceptanceProof` without a skipped branch.
- **Immutable Procedure Outcome:** GREEN. `references/browser.md` is included and recursively verified in the atomic acceptance-proof snapshot; procedure-byte races fail before publication. The npm dry-run contains the procedure and V2 proof modules while the public bin remains `dist/src/cli.js`.
- **Validation:** Focused V2 declarations `69`; repository declarations `779`; both suites exit `0`. `npm run typecheck`, `git diff --check`, architecture scan, package dry-run, and real `npm run test:v2-containment` exit `0`.
- **Skipped Live Gates:** External authenticated browser flows, Android/iOS, live GitHub smoke, daemon, package publication, and public cutover remain outside Spec 3.
- **Checkpoint Commit:** `96709fa` — browser report contract, artifact policy, package procedure/snapshot, real fixture proof, and self-check fixes.

## 9. Final Action

Completed: the real browser fixture, artifact-safety policy, packed procedure, and unchanged public Interface are GREEN. Update the master and authorize Spec 4 next.
