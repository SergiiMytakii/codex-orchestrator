# Adaptive acceptance proof

Codex Orchestrator will support always-adaptive **Acceptance Proof** as a runner-owned phase: an **Adaptive Proof Agent** may use proof-phase shell, browser, Android, or smoke-test tools to navigate the product, repair proof scripts, analyze artifacts, and produce a structured proof report, while the Runner retains ownership of leases, timeouts, artifact validation, issue state, and publication. One proof loop iteration is implementation or rework followed by adaptive proof and a runner decision; the default iteration limit should be five.

## Considered Options

- Keep proof as deterministic commands only. Rejected because UI and live smoke proof often need bounded adaptation when navigation, launch state, onboarding, or timing differs from the scripted happy path.
- Let an ordinary implementation Agent own proof and issue state. Rejected because it crosses the Runner-Owned Publication Boundary and makes labels, comments, pushes, and final pass/fail decisions harder to audit.
- Add an Adaptive Proof Agent inside a runner-owned proof phase. Accepted because it preserves adaptive judgement while keeping state transitions and publication deterministic and testable.

## Consequences

The proof phase becomes an evidence-producing agent workflow, not just a command runner. Proof agents may use full proof-phase shell access and may perform limited Proof Script Repair in allowlisted proof-owned paths, but product code changes must become a Proof Rework Request that the Runner routes back through implementation. If a proof agent changes product code, the Runner blocks that proof result instead of treating it as validation.

The Proof Report must map each relevant acceptance criterion to a status, confidence, reasoning summary, and linked artifacts; a screenshot or smoke output without high-confidence analysis is not sufficient. Visual plans use runner-owned browser, mobile, or adaptive proof. Accepted non-visual plans use completion-report validation, where passed CLI/API/worker/smoke commands and artifacts must map back to each acceptance criterion without dispatching browser or device proof.

UI proof must satisfy a UI Evidence Contract inside the Proof Report. Screenshot or UI-dump evidence has to identify the exact user workflow, relevant viewport coverage, current artifact freshness, visual layout review, and user-facing copy review; screenshot-only command success is rejected rather than treated as a compatibility pass.

Android proof must use the Test Android Apps workflow and the runner-provided device lease rather than selecting or starting devices independently. The Android contract is hard: use the runner-provided `ANDROID_SERIAL`, drive the app through `adb -s`, derive tap coordinates from the UI tree, and save screenshot, UI dump, and logcat artifacts.

The configuration model should introduce `reviewGates.acceptanceProof` as the canonical policy surface, while preserving `reviewGates.visualProof` only as a migration adapter for existing repository settings. During an Acceptance Proof Loop the issue remains claimed with the running label; the Runner changes issue labels only at terminal states: review-ready after proof passes, or blocked after the configured iteration limit is exhausted.

The Runner validates the diff after every proof phase. Proof Script Repair is accepted only in allowlisted proof-owned paths; any product-code diff produced during proof blocks that proof result and must be routed back through implementation. The Adaptive Proof Agent may use full local proof-phase shell access, and network may be available when the proof requires live product behavior, but GitHub write authority and publication remain unavailable to the proof phase and are still checked by the safety gate.

A Proof Report passes only when every required acceptance criterion has `status=passed`, `confidence=high`, at least one linked Proof Artifact, and no forbidden proof-phase diff. Partial proof is evidence for a blocker or rework request, not a Draft PR Handoff condition.
