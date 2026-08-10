# 01 — Cut over authorized Issue delivery to proof-before-Review

## Parent

https://github.com/SergiiMytakii/codex-orchestrator/issues/1262

## Observable outcome

One open Issue carrying the configured delivery authority runs directly through `implementation → affected checks → Acceptance Proof → complete Review → publication`; the package neither chooses nor executes an internal planning/spec route.

## Scope

- In scope: cut over the public `RunIssue.runIssue` lifecycle, direct-authority and initial-delivery Run state/contracts, packaged worker operations, and affected tests to direct issue authority, immutable candidate-bound proof before the first complete Review, and publication only for that unchanged approved candidate.
- Out of scope: Plan, `to-spec`, `to-tickets`, graph coordination, target-repository behavior, release, live smoke, consumer rollout, and any new planning or orchestration layer.

## Acceptance criteria

- [ ] `agent:auto` on the concrete open executable Issue is the package execution authority; a planning-context Parent or Parent link without separate delivery authority launches no implementation or publication.
- [ ] The direct happy path observes exactly `implementation → affected checks → Acceptance Proof → one fresh complete standards Review → publication` for one immutable candidate.
- [ ] Review receives the exact Issue authority, changed scope, candidate identity, Checked Change, and validated ProofReceipt; drift after proof invalidates affected proof before Review or publication.
- [ ] The initial Review is read-only, covers requirement fidelity and correctness/repository standards, launches one fresh `standards_reviewer`, and performs no repair or Git action.
- [ ] Complexity-driven triage/spec-author/spec-review runtime operations, route/state/schema branches, callers, generated contracts, and tests with no remaining live owner are deleted rather than wrapped or aliased.
- [ ] Decision Delta, unresolved product/ownership ambiguity, and out-of-scope work return a precise issue-local blocker without inventing a spec or delivery authority.
- [ ] Existing authorization, containment, denied-path, candidate/tree, Checked Change, Acceptance Proof, process-fencing, PendingEffect, and publication-reconciliation safety remains fail closed.

## Owner and proof seam

- Owner / public seam: `RunIssue.runIssue`; direct-authority and initial-delivery Run progression/state projection; candidate materialization, Checked Change, Acceptance Proof/ProofReceipt, code-review invocation, and Runner-owned publication effects.
- Proof: first-RED public lifecycle tests assert launch/effect order, exact candidate/proof/Review correlation, fresh reviewer identity, planning-context non-authority, no triage/spec workers, and no publication on stale proof; run focused lifecycle/contracts plus `npm run typecheck`.
- Why false behavior cannot pass: the production-seam event trace and candidate identities fail if any forbidden worker launches, order changes, receipt belongs to another candidate, or publication occurs before applicable Review.

## Blocked by

None.

## Final state

AFK: `ready-for-agent`. State does not authorize implementation.
