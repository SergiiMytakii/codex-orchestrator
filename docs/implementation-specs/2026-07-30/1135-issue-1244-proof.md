# Issue #1244 proof

Baseline: `ad47b503ad947c2df44a9bfd3b15a33745dac0f5`.

## Delivered

- Direct and independently approved spec routes create one exact `DeliveryAuthority` hash in the same Run.
- The authority binds implementation, independent code review, candidate capture, `CheckedChange`, proof readiness, and publication state.
- Approved specs proceed directly to implementation without spending an implementation cycle.
- Product decisions are immutable spec revisions returned as `spec-frozen`; trusted answers create the next revision and full independent review without retriage.
- Edited, deleted, wrong-prefix, or permission-unverifiable answers do not reach implementation.
- The separate awaiting-user route, result, label, lifecycle, state machine, question budget, and ambiguity-review operation were deleted.

## Focused proof

- Build: `npm run build --silent`.
- Same-Run and answer path: 3/3 focused `v2-run-issue` tests passed.
- Route/spec/authority/review/proof contracts: 47/47 focused tests passed.
- Run-state and authority validation: 15/15 tests passed after the focused assertion repair.
- Workflow package/generation: 11/11 focused tests passed; `npm run verify:workflow --silent` passed.
- Diff hygiene: `git diff --check` passed.

## Simplification evidence

- Committed slice: 630 added, 2917 deleted, net -2287 lines.
- V2 production LOC: 22578 -> 21294 (-1284).
- `src/v2/run-issue.ts`: 4141 -> 4080 (-61).
- Removed production owners/mechanisms: `waiting-human.ts`, `waiting-human-coordinator.ts`, awaiting-user route/result/label/lifecycle, candidate ambiguity-review routing and operation.
- No full suite was rerun for this slice by explicit user direction; verification stayed scoped to changed contracts.

## Known environment limitation

`npm run refresh:workflow` against the ambient personal Codex home still rejects the already-known unsupported shared eval assertion. The committed workflow was regenerated from the prior validated shared eval plus the current packaged skills, and its independent manifest verification passed.
