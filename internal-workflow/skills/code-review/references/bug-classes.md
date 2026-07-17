# Code Review Bug Classes

Use this reference for substantial reviews and broad bug hunts.

## Review Mindset

- Findings first; summary second.
- Prefer a few high-signal findings over a long speculative list.
- Read enough surrounding code to understand the real execution path.
- Include pre-existing bugs only when they materially affect the reviewed path.
- Treat workaround-shaped code as a review target.
- Treat duplicated business rules, builders, cleanup rules, normalization, cache keys, restart paths, and persistence math as likely drift vectors.
- Treat "tests pass" as insufficient when contracts, ownership, or source-of-truth logic moved.
- Do not stop after the edited hunk unless the change is truly trivial.

## Non-Negotiable Passes

Every substantial review covers:

1. **Scope**: exact diff/commit/branch/files under review.
2. **Execution path**: entrypoints, callers, callees, side effects, state writes, network/DB boundaries, cleanup.
3. **Architecture fit**: correct owning layer, no leaky abstractions, no duplicate source of truth, no symptom patch in the wrong layer.
4. **Invariants**: validation, authorization, ordering, idempotency, data shape, permissions, cache visibility, and lifecycle rules.
5. **Failure modes**: empty, null, duplicate, stale, delayed, retried, timeout, cancellation, partial failure, concurrent execution.
6. **Blast radius**: DTOs, schemas, cache keys, feature flags, config, metrics, tests, consumers, migrations, and backward compatibility.
7. **Verification**: narrow tests/lint/build/analyzer for touched areas, or a clear note when a check cannot run.

## Bug Classes To Hunt

- Control-flow mistakes: wrong branch, inverted predicate, missing return, incorrect default, off-by-one, pagination errors.
- State/lifecycle bugs: stale state, forgotten reset, double writes, orphaned cleanup, leaks, inconsistent derived state.
- Async/concurrency bugs: missing `await`, race windows, non-idempotent retries, shared mutable state, closure mutation in retryable callbacks.
- Partial-failure bugs: one side effect succeeds while durable follow-up fails.
- Contract drift: DTO/schema/type mismatch, nullable changes, enum drift, serialization differences, `ObjectId`/`Date` runtime mismatch.
- Cache bugs: stale reads, bad cache keys, cross-tenant leakage, missed invalidation, TTL mismatch.
- Auth regressions: missing actor checks, wrong tenant scope, optional-param bypass, client-only enforcement.
- Data correctness: timezones, DST, rounding, units, locale parsing, duplicate filtering, sort instability.
- UI/API regressions: optimistic state not rolled back, loading/error/empty states broken, incompatible response handling.
- Observability gaps: critical failures suppressed without logs, metrics, retries, or surfaced errors.
- Workarounds: magic delays, one-off guards, forced ordering, duplicated normalization, cross-layer patches.
- Architecture drift: business logic in the wrong layer, source-of-truth splits, unnecessary coupling.
- Deep-module drift: shallow pass-through modules, hypothetical one-adapter seams, lost locality, weak leverage, or tests reaching inside the implementation instead of crossing the Module Interface.

## Mandatory Questions

Ask the relevant subset for each meaningful path:

- What happens with empty, null, duplicated, delayed, retried, stale, or out-of-order input?
- What happens when a dependency throws, times out, returns partial data, or returns stale data?
- Can two executions interleave and corrupt state, leak data, or duplicate work?
- Are validation and authorization enforced before side effects?
- Does the change rely on a type guarantee that is weaker at runtime?
- Do all readers and writers agree on field names, units, nullability, and semantics?
- If state is rebuilt, cloned, merged, normalized, serialized, or persisted, are all required fields preserved?
- Can feature flags, optional params, defaults, or fallback paths bypass intended behavior?
- If failure happens halfway through, what durable state remains and who repairs it?
