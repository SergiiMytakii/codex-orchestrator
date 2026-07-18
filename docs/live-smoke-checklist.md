# V2 live smoke checklist

The live smoke validates the packed npm artifact against a scratch GitHub repository. It creates real remote state and requires explicit authorization.

## Default gate

```sh
npm run smoke:live
```

The default `core-release` profile is intentionally small:

- `package-install`: pack, install in a clean consumer, and run the public CLI.
- `real-codex`: complete one issue with the explicitly pinned live-smoke model
  `gpt-5.6-luna` and strict structured reports.
- `browser-proof`: exercise a current browser workflow and validate proof artifacts.
- `safety-negative`: confirm a forbidden path/effect is blocked without publication.

The supplemental non-mobile V2 matrix remains available through
`--profile v2-regression` or explicit `--scenario` values. It covers each
distinct discovery, policy, recovery, diagnostics, non-visual proof, and
quality-gate behavior once. Use it when those surfaces change.

Mobile proof remains explicit through `--profile mobile-proof`. The `full`
profile is the union of core release, V2 regression, and mobile scenarios; it
does not retain historical aliases that exercise the same fixture and result.

Every model-backed scenario launches the real Codex CLI with
`gpt-5.6-luna`, overriding package role defaults. Deterministic recovery and
negative cases inject their fault only around the real model result. The report
records the observed Luna invocation count per scenario. Discovery and mobile
device gates are explicitly model-free and fail if they unexpectedly launch a
model.

## Preconditions

- Use only the configured scratch repository.
- `gh` and the parent Codex CLI are authenticated.
- Build and focused local tests pass.
- No production repository is supplied through an override.
- Cleanup mode is enabled unless retained artifacts were explicitly requested.

## Required evidence

- Report path printed by the smoke command.
- Exact packed package and public CLI path.
- Scenario result and typed failure evidence where applicable.
- Issue, branch, pull-request, label, and temporary-directory cleanup result.
- No open run-owned GitHub objects after eventual-consistency retries.

## Failure handling

Do not weaken report, credential, containment, proof freshness, publication, or cleanup contracts merely to make the smoke green. First classify whether the failure is product behavior, fixture/report shape, external transport, or stale cleanup state. A report-shape repair may rewrite only its JSON report; it may not manufacture or alter evidence.

Local-only command output may contain machine paths. Credentials are forbidden in all artifacts, while publishable evidence also strips host identity and accepts only screenshots or sanitized generated summaries.

## Compact release signoff

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm pack --dry-run --json` contains only the V2 package boundary
- [ ] `npm run smoke:live` passes all four default scenarios
- [ ] strict cleanup reports no remaining run-owned remote or temporary state
