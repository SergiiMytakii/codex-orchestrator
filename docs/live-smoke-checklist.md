# V2 live smoke checklist

The live smoke validates the packed npm artifact against a scratch GitHub repository. It creates real remote state and requires explicit authorization.

## Default gate

```sh
npm run smoke:live
```

The default `core-release` profile is intentionally small:

- `package-install`: pack, install in a clean consumer, and run the public CLI.
- `spec-first`: approve a compact spec and implement it in the same Run.
- `product-question`: freeze one exact owner question, accept one trusted answer,
  and continue the same Run through approved spec and delivery.
- `review-feedback-continuation`: freeze trusted feedback and update the same PR
  through the same full review, checks, and proof loop.

The supplemental non-mobile V2 matrix remains available through
`--profile v2-regression` or explicit `--scenario` values. It covers each
distinct discovery, policy, recovery, diagnostics, non-visual proof, and
quality-gate behavior once. Use it when those surfaces change.

Its scenarios are intentionally bound to these current owner behaviors:

- `discovery-matrix`: an unlabeled issue is ineligible and creates no branch or
  PR.
- `commit-policy`: an agent-authored commit is rejected and never published.
- `incomplete-progress-rework`: one interrupted transport attempt resumes once
  and reaches review-ready without opening a new implementation cycle.
- `report-repair`: one invalid report is repaired as report-only work and then
  reaches review-ready.
- `diagnostics`: `doctor` and `status` inspect without changing target state,
  after which the normal delivery path still succeeds.
- `authoritative-candidate-publication`: a deliberately stale shared-index entry
  loses to final worktree bytes; exact-schema check receipts, the published commit tree,
  released candidate pin, and removed immutable execution worktrees prove the
  authoritative-candidate chain end to end.
- `acceptance-proof-rework`: one proof rejection opens exactly one new cycle
  before publication.
- `acceptance-proof-negative`: an external proof blocker stops without a branch
  or PR.
- `quality-gates`: the fifth failed configured check exhausts the implementation budget
  without publication.

`browser-proof` is a deterministic contract smoke for current-run responsive
screenshot receipts; it does not claim to drive a real browser. Real browser UI
proof remains a separate workflow with browser-owned evidence.

The `review-feedback-continuation` regression scenario proves: trusted
unresolved feedback is frozen,
one complete independent review/checks/proof loop reruns, one fast-forward commit updates the same PR,
one summary marker is posted, replay is effect-free, and cleanup leaves no
unexpected branch or PR. Its one-shot daemon invocation is constrained to the
run-owned issue and uses a run-isolated orchestrator home. Live execution remains explicit-only;
local tests must not substitute a production repository.

The `full` profile is the union of core release and the supplemental V2
regression scenarios. Fixture-specific Android and iOS real gates are not
GitHub live-smoke scenarios: they require explicit runner-owned device,
fixture, lease, and artifact inputs and remain under their dedicated mobile
proof procedures and tests.

Every model-backed scenario launches the real Codex CLI with
`gpt-5.6-luna`, overriding package role defaults. Deterministic recovery and
negative cases inject their fault only around the real model result. The report
records the observed Luna invocation count per scenario. Discovery is
explicitly model-free and fails if it unexpectedly launches a model.

## Preconditions

- Use only the configured scratch repository.
- `gh` and the parent Codex CLI are authenticated.
- The fixed scratch lock branch can be acquired exclusively before mutation.
- Build and focused local tests pass.
- No production repository is supplied through an override.
- Cleanup mode is enabled unless retained artifacts were explicitly requested.

## Required evidence

- Complete report emitted by the smoke command before its temporary root is deleted.
- Exact packed package and public CLI path.
- Scenario result and typed failure evidence where applicable.
- Issue, branch, pull-request, label, candidate-ref/worktree, process, and
  temporary-data cleanup result.
- No open run-owned GitHub objects after eventual-consistency retries.

## Failure handling

Do not weaken report, credential, containment, proof freshness, publication, or cleanup contracts merely to make the smoke green. First classify whether the failure is product behavior, fixture/report shape, external transport, or stale cleanup state. A report-shape repair may rewrite only its JSON report; it may not manufacture or alter evidence.

Local-only command output may contain machine paths. Credentials are forbidden in all artifacts, while publishable evidence also strips host identity and accepts only screenshots or sanitized generated summaries.

## Compact release signoff

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm pack --dry-run --json` contains only the V2 package boundary
- [ ] `npm run smoke:live` passes all four default lifecycle scenarios
- [ ] strict cleanup reports no remaining run-owned remote or temporary state
