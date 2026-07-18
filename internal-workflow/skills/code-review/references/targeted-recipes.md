# Code Review Targeted Recipes

Load this reference when the diff shape matches one of these recurring risks.

## Activation

- new field or contract: run **New Field Threading**
- transaction/retry/queue/background job: run **Retryable Persistence**
- DTO/schema/type/persistence change: run **Runtime Contract Alignment**
- cache or invalidation change: run **Cache Coherence**
- server/AI/cache/fallback state merged into client state: run **State Merge Precedence**
- preview/trace/summary/score/winner field: run **Aggregation Cardinality**

## New Field Threading

1. Search for the field name.
2. Search nearby `build`, `apply`, `adjust`, `replan`, `normalize`, `merge`, `compile`, `serialize`, `clone`, and fallback helpers.
3. Confirm the field survives primary construction, correction/replan paths, persistence reload, response serialization, and externally visible tests.

## Retryable Persistence

1. Read the whole transaction/retry callback.
2. List outer-scope variables referenced inside it.
3. Flag mutation of outer arrays, counters, iterators, derived inputs, or one-shot streams that changes behavior on retry.
4. Compare transactional and non-transactional paths for parity.

## Runtime Contract Alignment

1. Compare DTO validation, internal type, persistence schema, normalization, API response shape, and frontend/state consumers.
2. Treat `string` versus `ObjectId`, `Date` versus string, enum drift, and nested optional mismatches as review targets.
3. Prefer boundary validation when malformed input should be rejected.

## Cache Coherence

1. Identify cache key inputs, tenant/user scope, feature flags, locale, and permissions.
2. Confirm invalidation covers every write path and revalidation timing matches user-visible expectations.
3. Check stale reads, cross-tenant leakage, and optimistic UI/cache rollback.

## State Merge Precedence

1. Identify precedence between user-entered state, server state, AI-generated state, fallback state, cache state, and defaults.
2. Verify omitted fields, empty objects, `false`, `0`, or `null` cannot erase stronger user choices unless intended.
3. Check both backend merge logic and frontend state update logic.

## Aggregation Cardinality

1. Determine whether source data is global, per-group, per-item, per-step, or per-tenant.
2. Verify top-level summary/trace/score/winner fields do not collapse multiple meaningful entities into one misleading value.
3. Treat `.find()`, first-selected, `sort()[0]`, and flat-array winner logic as suspicious when multiple groups can each have a result.
