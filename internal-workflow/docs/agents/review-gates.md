# Review Gates

This file owns applicability only. Approved-spec execution follows
[`implementation-review-loop.md`](implementation-review-loop.md), which owns
checkpoint order, Full/Closure topology, durable state, and final coverage.
Direct work uses the gates below without manufacturing Module state.

## Cleanup Review

Do not launch a separate `$cleanup-review` from size or risk classification
alone. The final `$code-review` spec/standards lens owns bounded cleanup for
simple, medium, large, and high-risk changes; high runs that lens in its own
parallel reviewer track.

Use separate `$cleanup-review` only when the user, approved source, or repo
policy names a concrete evidenced simplification risk that cannot fit the
bounded spec/standards lens. It runs before final `$code-review`; approved-spec
execution lets the shared Module schedule it.

Treat a change as large only when it contains several independently verifiable
runtime workflows or material cross-owner, cross-repo, release-sequencing, or
rollback coordination. File count, module count, or a broad mechanical diff is
not enough. Default a coherent feature with one behavior and one validation
path to medium even when it touches several files.

Cleanup is not a correctness review. Its skill owns the detailed lens,
confidence handling, repair integration, and output contract.

## Final Code Review

Run final `$code-review` when implementation changes include any of:

- a medium/large feature or shared multi-module business behavior;
- API/DTO/schema, migration, persistence, auth, permission, payment, cache,
  concurrency, background-job, or shared-state contracts;
- shared UI/navigation/middleware/core flows;
- runtime logic across three or more files when the change is behavioral rather
  than mechanical and crosses one owner or validation seam.

Do not invoke it automatically for documentation/copy/comments, tests-only or
styling-only changes, formatting/renames, mechanical refactors, or isolated
one-file fixes with low regression risk.

`$code-review` owns reviewer topology, confidence, auto-fix, and output rules.
Its spec/standards reviewer owns the bounded cleanup lens for every profile; do
not launch `$cleanup-review` for the same settled diff without an explicit
concrete reason beyond size or risk labels.
For approved specs, required final coverage remains part of the shared
Implementation Review State.
