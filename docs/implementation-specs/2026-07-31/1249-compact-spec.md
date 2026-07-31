# Issue #1249 compact implementation spec

Baseline: #1248 checkpoint `1c5e4e2`.

## Outcome

Review-ready direct and spec-required Runs initialize and continue through the
same trusted same-PR feedback validation/effect loop. Continuation preserves
the existing DeliveryAuthority and does not repeat triage, spec authoring, or
spec review.

## Gates

1. Initial publication initializes `reviewFeedback` for every route after the
   exact published head is known.
2. Review-ready observation requires the existing terminal, initialized
   feedback state, package-owned observer, and a clear independent review; it
   does not branch on route.
3. Activation reuses the existing frozen batch, semantic round budget,
   implementation/full-review/check/proof loop, and typed fast-forward
   publication effects.
4. The frozen DeliveryAuthority remains byte-for-byte unchanged through every
   feedback round. No triage or spec coordinator operation is re-entered.

## Negative contract

Wrong repository/PR/head/source/claim, untrusted or revoked permission,
duplicate batch, publication ambiguity, or round exhaustion continues to use
the existing fail-closed observer/validator and pending-effect behavior.
Force-push, merge, review-thread resolution, a second feedback lifecycle, and
new retry/state owners remain out of scope.

## Contract Test Ledger

| Contract ID | Claim | Production seam | Proof |
| --- | --- | --- | --- |
| C-FEEDBACK-001 | Both routes initialize one feedback owner at initial publication | `publish` terminal patch | direct/spec review-ready fixture |
| C-FEEDBACK-002 | Both routes share exact observation, activation, repair, review, checks, proof, and fast-forward update | `continueReviewReady` and existing feedback loop | direct/spec trusted batch fault scenario |
| C-FEEDBACK-003 | Spec authority and pre-publication work are not repeated | existing DeliveryAuthority plus route/spec call counters | byte equality and no-reentry assertions |
