# Issue #1247 completion proof

Baseline: `6fb42f14a4f21112bf1c465f2bb0241a5bb69027`.

## Result

- Spec `DeliveryAuthority` contains final content/content hash, revision/revision
  hash, and the exact frozen approval receipt. The receipt includes the accepted
  review report hash and independent reviewer attempt/session identity.
- Implementation and independent review receive the same validated full value.
- Candidate capture and Checked Change receive the canonical authority hash;
  proof/publication remain transitively bound without copying approval/content
  bytes into effect records.
- Direct authority bytes are unchanged.
- A forged persisted content/receipt mismatch is rejected as
  `state-schema-unsupported` before owner lock, worker launch, effects, or budget
  changes.
- Authority has no policy projection and owns no store, process, phase, or
  lifecycle.

## Verification

- Focused production-seam spec route and stale-authority rejection: 2/2 passed.
- Delivery authority, spec delivery, implementation reviewer, and run-store:
  24/24 passed.
- Typecheck and `git diff --check`: passed.
- Independent Full review found `REVIEW-AUTH-001` (exact receipt was initially
  reduced to a hash) and one proof gap. The implementation now carries the exact
  receipt and the production-seam tests cover both worker inputs, candidate and
  Checked Change hash bindings, downstream non-leakage, and effect-free stale
  authority rejection.
- Independent Closure verified `REVIEW-AUTH-001` fixed with no new findings;
  the prior medium production-proof gap is closed and no material residual gap
  remains.

The Contract Ledger rows in the compact spec become valid at the focused
#1247 commit; later tickets that touch authority, Run persistence, candidate,
proof, or publication must mark them stale and reprove them.
