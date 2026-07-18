# Review Gates

This file owns review applicability. Review execution mechanics live in
[`review-protocol.md`](review-protocol.md); approved-spec review shape lives in
[`spec-implementer/references/review-loop.md`](../../skills/spec-implementer/references/review-loop.md).

## Final Code Review

Run final `$code-review` for behavior-changing work that affects:

- medium/large shared business behavior;
- API/DTO/schema, migration, persistence, auth, permission, payment, cache,
  concurrency, background jobs, or shared-state contracts;
- shared UI/navigation/middleware/core flows;
- runtime logic across three or more files when it crosses an owner or
  validation seam.

Do not invoke it automatically for docs, copy, comments, tests-only or
styling-only changes, formatting, renames, mechanical refactors, or isolated
low-risk one-file fixes.

`medium` is the normal review profile. API, persistence, statefulness, file
count, or orchestration strengthens the review focus only when it creates an
affected contract; none independently selects `high`.

## Cleanup

Cleanup is a lens inside the same final `$code-review`, never a separate gate.
Use bounded cleanup by default. Amplify it only when the user, approved source,
or repository policy names a concrete evidenced simplification risk; follow
`../../skills/code-review/references/cleanup-lens.md` for that branch.

After one consolidated repair, coordinator verification plus affected
validation closes ordinary medium/low behavior-preserving findings. Use
Closure only for the triggers in `review-protocol.md`.

## Validation Depth

For simple and medium work, run targeted behavior proof and the smallest
affected integration check. Run a full repository suite only when explicitly
required by repository policy, when broad contract fan-out cannot be isolated,
or for a genuinely `high` task.
