# Live-smoke scenario value audit — 2026-08-18

## Scope

Reviewed all 12 scenarios registered in `scripts/live-smoke.mjs`, their profile
placement, fault injection, terminal assertions, packed-package boundary, and
the focused contracts in `test/v2-live-smoke-script.test.ts`. Production-owner
coverage was cross-checked against `src/v2/` and the broader `test/v2-*.test.ts`
suite. Coverage mode: full audit of the live-smoke registry.

Focused live-smoke contract tests were run: 35 passed, 0 failed. The mutating
GitHub live smoke was not run because the tracked source tree is not a clean
immutable HEAD.

## Summary

- Good live scenarios: 10
- Rewrite: 1
- Delete from live smoke: 1
- Keep temporarily: 0

The registry is mostly valuable, but it overpays for two deterministic contract
checks and misses three higher-value lifecycle integrations: configured-check
rework, initial Review rejection/repair, and publication-effect recovery.

## Good

- `package-install` (`scripts/live-smoke.mjs:457`) — keep. This is the only
  scenario that proves the packed tarball can be installed in a clean consumer
  and then complete the public CLI lifecycle. That package boundary cannot be
  replaced by source-level tests.
- `discovery-matrix` (`scripts/live-smoke.mjs:479`) — keep. It is cheap and
  model-free, and proves real GitHub issue-label eligibility plus absence of a
  remote branch or PR. Local adapter mocks cannot prove the complete
  scratch-repository observation path.
- `commit-policy` (`scripts/live-smoke.mjs:488`) — keep. It injects a real Git
  commit after a model-backed implementation and proves the Runner rejects
  worker-owned commit authority without publication.
- `incomplete-progress-rework` (`scripts/live-smoke.mjs:292`, fault at line
  793) — keep. It crosses the real Codex process boundary, persists one
  transport retry, resumes, and publishes. This protects a failure mode that
  source-only process tests cannot prove through the packed runtime.
- `report-repair` (`scripts/live-smoke.mjs:292`, fault at line 880) — keep. It
  dynamically corrupts only the first implementation report and proves the
  next full implementation succeeds without a semantic-cycle increment.
- `authoritative-candidate-publication` (`scripts/live-smoke.mjs:292`,
  assertions at line 320) — keep. It uniquely proves index/worktree authority,
  exact candidate-tree publication, and cleanup of candidate refs and execution
  worktrees against real Git and GitHub effects.
- `acceptance-proof-rework` (`scripts/live-smoke.mjs:292`, fault at line 915) —
  keep. It proves a proof finding returns to implementation, increments the
  product cycle exactly once, refreshes validation, and then publishes.
- `acceptance-proof-negative` (`scripts/live-smoke.mjs:521`) — keep. It proves
  a typed external proof blocker produces no branch or PR. This is a distinct
  terminal path from safety and eligibility rejection.
- `review-feedback-continuation` (`scripts/live-smoke.mjs:377`) — keep and keep
  in `core-release`. It is the strongest scenario: real trusted inline feedback,
  daemon discovery, same-PR fast-forward update, refreshed checks/proof,
  persisted receipt, summary marker, labels, and effect-free replay.
- `safety-negative` (`scripts/live-smoke.mjs:529`) — keep. It proves a denied
  path such as `.env` remains a publication boundary through the packed runtime
  and exact remote no-publication assertions. It is not duplicated by
  `commit-policy`.

## Rewrite

- `diagnostics` (`scripts/live-smoke.mjs:501`) — preserve the behavior, but
  rewrite it as a model-free packed-CLI integration. The valuable assertion is
  that `doctor` and `status` return typed inspected results and leave config and
  Git state unchanged. Calling a complete implementation/proof/review/publication
  lifecycle afterwards mostly repeats `package-install`, consumes a real model,
  and does not strengthen the diagnostics contract. A rewritten scenario should
  invoke the installed packed CLI, snapshot target/config/remote state, run both
  commands, and assert exact no mutation without creating an eligible issue.

## Delete from live smoke

- `browser-proof` (`scripts/live-smoke.mjs:292`, fixture at line 944) — delete
  as a GitHub live-smoke scenario while retaining its local proof-contract tests.
  The wrapper discards the real model's proof artifacts and writes deterministic
  PNG/JSON fixtures itself; the live assertion only counts two screenshot
  receipts. It does not drive a browser, does not observe a real UI, and its
  meaningful contract is already better exercised by
  `test/v2-browser-proof.test.ts`, `test/v2-report-contracts.test.ts`, and the
  live-smoke wrapper self-test. A real browser gate would be a new, explicitly
  provisioned workflow rather than this synthetic GitHub scenario.

## Keep temporarily

None.

## Missing high-value scenarios

### P0 — configured-check rework

Inject one real failing configured check, require the next implementation to
repair the product, then prove a fresh passing check receipt, proof, Review, and
publication on the corrected candidate. Current live scenarios prove proof
rework but never exercise the check-failure owner path, even though check
failures are a primary implementation-loop input. Local coverage exists in
`test/v2-run-issue.test.ts` but does not prove command execution through the
packed runtime.

### P0 — initial Review rejection and targeted repair

Make the first pre-publication code Review return one coherent in-scope finding,
then prove the targeted repair uses the exact delta, refreshes affected proof,
passes independent Review, and publishes only the repaired candidate. The
current feedback scenario starts after a PR exists; no live scenario proves the
initial Review-to-repair loop.

### P0 — publication effect reconciliation

Inject a transport failure after the remote branch/PR effect is created but
before local confirmation, restart the packed CLI, and prove it observes and
adopts the exact existing effect without duplicate commit, branch, PR, comment,
or model work. This is one of the highest-risk Runner responsibilities and is
currently covered only by local fault-injection tests such as
`test/v2-run-issue.test.ts` around effect-before-confirmation reconciliation.
The harness must fault the package-owned GitHub adapter boundary rather than
simulating success in scenario code.

## Missing medium-value scenarios

- **Authorization revoked before publication** — remove `agent:auto` or replace
  the expected issue state after implementation but before publication, then
  prove an authority block and no remote branch/PR. This would validate fresh
  GitHub authorization at the irreversible boundary.
- **Untrusted or stale review feedback is effect-free** — create feedback that
  is resolved, outdated, wrong-head, or otherwise non-authoritative and prove
  daemon replay performs no model call or remote mutation. The positive trusted
  path is covered; the live negative trust boundary is not.
- **Issue-scoped `Verification:` command** — use an issue command that differs
  from configured fallback checks and prove its receipt is the one bound to the
  candidate. This is useful but lower priority than check rework because local
  tests already cover selection semantics.

## Not recommended as new live scenarios

- Separate aliases for baseline happy path, non-visual proof, scoped commit, or
  ordinary publication: `package-install` and
  `authoritative-candidate-publication` already cover those boundaries.
- Android or iOS gates without real runner-owned devices, leases, and artifacts.
- More malformed-report counts or semantic-cycle exhaustion cases; those are
  deterministic state-machine contracts and belong in local tests.
- Cancellation and every individual setup/config validation error; local
  process and contract tests provide better, cheaper fault control unless a
  concrete package-boundary regression appears.

## File coverage

| Reviewed file | Status | Notes |
| --- | --- | --- |
| `scripts/live-smoke.mjs` | mixed | 10 good scenarios, 1 rewrite, 1 live-delete candidate |
| `test/v2-live-smoke-script.test.ts` | good | Pins inventory and scenario mechanics; many assertions are intentionally source-contract checks |
| `test/v2-run-issue.test.ts` | good | Used to identify owner paths currently proven only with local fault injection |
| `test/v2-browser-proof.test.ts` | good | Stronger home for deterministic browser proof validation |
| `test/v2-report-contracts.test.ts` | good | Stronger home for exact visual proof report shape |

## Recommended order

1. Add configured-check rework live coverage.
2. Add initial Review rejection/targeted-repair live coverage.
3. Add publication effect reconciliation with a package-adapter fault seam.
4. Rewrite `diagnostics` as model-free packed-CLI smoke.
5. Remove synthetic `browser-proof` from the live registry and keep its local
   contracts; add a real browser workflow only when real browser authority and
   evidence are available.
6. Reassess `v2-regression` composition and runtime after these replacements.
