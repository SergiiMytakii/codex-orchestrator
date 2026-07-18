# Bugfix Quality Gate

For bug fixes, do not claim completion until these are clear:

- Invariant: final user/system-visible outcome that must be true.
- Boundary: paths, states, async events, retries, caches, workers, or integrations that can affect it.
- Proof: test/log/smoke/check that fails on the old behavior and verifies the final outcome, not only an intermediate signal.
- Negative proof: what the proof does not cover.
- Claim limit: final response must not claim broader coverage than the changed code and proof support.

If the bug spans state, async, lifecycle, retries, cache, auth, persistence, or cross-module contracts, include the competing condition in the regression proof when feasible.
