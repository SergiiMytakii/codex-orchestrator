# 02 — Use one targeted repair loop without numeric semantic exhaustion

## Parent

https://github.com/SergiiMytakii/codex-orchestrator/issues/1262

## Observable outcome

Initial Review findings and trusted same-repository PR feedback enter the same Implement-owned targeted repair loop: one consolidated repair batch, affected proof, and one fresh targeted Review preserve approval of untouched scope without numeric semantic exhaustion.

## Scope

- In scope: targeted-repair and trusted-feedback Run state/projection, Run-owned repair progression, existing review operation/report contract, repair target/capsule data, affected check/proof invalidation, logical Implement assignment, and trusted PR-feedback continuation/publication.
- Out of scope: a second review lifecycle, approval ledger, generic impact engine/state machine, force-push, automatic thread resolution, merge/release, untrusted feedback, and unrelated target-repository repairs.

## Acceptance criteria

- [ ] All in-scope blockers for one reviewed revision are consolidated into one repair batch executed by the same logical Implement owner.
- [ ] An isolatable repair reruns only affected checks and proof obligations, then invokes one fresh `standards_reviewer` with previous target identity, repair delta, repaired blocker IDs, direct impact cone, and affected proof; when impact cannot be isolated reliably, it reruns complete checks/proof and one complete Review.
- [ ] Approval of untouched scope remains valid for isolatable impact; complete Review is used only when the production contract proves impact isolation is not reliable.
- [ ] Sixth and later valid in-scope repairs continue; reviewer count, fifth implementation cycle, and fourth or later trusted post-PR round never produce semantic `exhausted`.
- [ ] A repeated deterministic blocker cannot be reported as success: the next result is either observable in-scope progress or an exact authority/preservation/proof boundary from the Parent.
- [ ] Trusted same-repository PR feedback preserves source/head/permission checks, uses the same targeted loop, and settles one fast-forward-only update; quiet PR is effect-free and unresolved or untrusted feedback grants no repair authority.
- [ ] Numeric implementation/reviewer/post-PR semantic budgets, obsolete unconditional full-rereview-after-every-repair mechanics, and duplicate validation progression state/callers/tests are deleted without compatibility aliases or pass-through owners.

## Owner and proof seam

- Owner / public seam: Run repair data and `src/v2/validation-progression.ts`; existing code-review invocation/report capsule; affected Checked Change/ProofReceipt binding; `src/v2/review-feedback.ts`; public `RunIssue.runIssue` Git/GitHub effects.
- Proof: first-RED initial and post-PR lifecycle tests cover consolidated findings, targeted capsule fields, untouched approval, affected-only reproof, forced complete Review only for unisolatable impact, six-plus repairs, four-plus trusted feedback rounds, and one fast-forward update; run focused review/feedback/lifecycle contracts plus `npm run typecheck`.
- Why false behavior cannot pass: exact invocation capsules, reviewer identities, proof receipts, repair counts, and Git effect logs expose a full rereview, stale approval, hidden limit, untrusted authority, or duplicate/force publication.

## Blocked by

[#1263 — Cut over authorized Issue delivery to proof-before-Review](https://github.com/SergiiMytakii/codex-orchestrator/issues/1263).

## Final state

AFK: `ready-for-agent`. State does not authorize implementation.
