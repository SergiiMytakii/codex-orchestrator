# Contract Test Ledger

Use this shared ledger for behavior-changing work where a passing happy-path test could still miss a contract defect. The ledger turns review-class risks into testable obligations before implementation.

## When Required

Create or update a contract test ledger when the task changes any of these:

- API, DTO, schema, serialization, persistence, or externally visible response shape
- ordering, lifecycle events, state transitions, retries, idempotency, timeout, cancellation, or background jobs
- cache keys, invalidation, state merge precedence, fallback behavior, profile/global/mobile overrides, defaults, or feature flags
- evidence, trace, snapshot, audit, summary, aggregation, score, winner, or generated artifacts
- shared behavior read by multiple callers, tenants, users, groups, children, or projections

For narrow UI copy, docs-only, formatting, tests-only, or isolated styling changes, the ledger is not required.

## Required Shape

Keep the ledger compact. Use one row per invariant:

```markdown
## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| <observable rule> | <real failure mode> | <exact test name/command or manual proof> | planned / red / green / blocked |
```

Rules:

- The invariant must be observable through the public interface or the same seam real callers use.
- The risk must name the concrete bug class, not a vague "edge case".
- The first test/proof must fail before the fix unless the ledger records why a RED signal is impossible.
- `blocked` requires the missing seam, fixture, service, or decision that prevents proof.
- Keep the ledger current as implementation proceeds; do not backfill it only at the end.

## Invariant Prompts

Ask the relevant subset before the first RED test:

- **Ordering:** What must happen before/after terminal events, snapshots, persistence writes, notifications, or cleanup?
- **Precedence:** Which source wins among user input, profile, mobile, global, server, cache, AI, fallback, default, `null`, `false`, `0`, and empty objects?
- **Threading:** Does each new field survive construction, normalization, cloning, retry, persistence reload, serialization, and every visible consumer?
- **Runtime contract:** Do validation, internal types, persistence schema, API response, and consumers agree on names, units, nullability, enum values, and date/object formats?
- **Retry/idempotency:** What changes on retry, and which snapshots, counters, streams, timestamps, writes, or side effects must be rebuilt instead of reused?
- **Determinism:** When sort keys, timestamps, scores, priorities, or winners tie, what stable tie-breaker makes output repeatable?
- **Evidence:** Which trace, audit, snapshot, Fresh-Context, summary, or generated artifact proves the behavior actually happened?
- **Partial failure:** If a dependency times out, throws, returns stale data, or fails after a side effect, what durable state remains and who repairs it?
- **Scope/cardinality:** Is data global, per-tenant, per-group, per-child, per-step, or per-item, and can one top-level field collapse multiple meaningful results?

## Review Feedback Loop

When code review finds a real contract defect, add or update one ledger row before fixing it:

- `Invariant`: the rule the implementation violated
- `Risk It Prevents`: the observed review finding
- `First Test / Proof`: the regression test or proof that would have caught it
- `Status`: `red` before the fix, then `green` after verification

If no correct public seam exists for the regression test, record that as `blocked` and name the architecture/testability gap. Do not replace a missing seam with an implementation-detail test unless the task explicitly approves that tradeoff.
