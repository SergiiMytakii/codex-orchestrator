## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Paginated REST comment reads preserve decimal comment and author IDs without combining incompatible `gh api --slurp` and `--jq` options. | Every issue run fails as `transport-failed` before orchestration starts on current GitHub CLI versions. | `test/v2-gh-issue-adapter.test.ts`: `GhCliIssueAdapter preserves decimal REST comment and author IDs above MAX_SAFE_INTEGER` | green |
| Comments returned by the GitHub adapter fit the persisted run-state text bound and retain an explicit truncation marker. | A prior 60,000-character orchestrator report makes every retry fail as `state-write-failed` before the issue can be claimed. | `test/v2-gh-issue-adapter.test.ts`: `GhCliIssueAdapter bounds historical comments to the persisted run-state contract` | green |
| Oversized comments are bounded before the GitHub write and Unicode is truncated only at a complete UTF-16 boundary, so GitHub stores the same body the adapter later verifies. | GitHub receives an oversized report, or splitting an emoji creates U+FFFD during argv encoding and makes a successful write appear failed and retryable. | `test/v2-gh-issue-adapter.test.ts`: `GhCliIssueAdapter preserves oversized Unicode comments across the GitHub argv round trip` | green |
