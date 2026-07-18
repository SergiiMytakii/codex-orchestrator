## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Paginated REST comment reads preserve decimal comment and author IDs without combining incompatible `gh api --slurp` and `--jq` options. | Every issue run fails as `transport-failed` before orchestration starts on current GitHub CLI versions. | `test/v2-gh-issue-adapter.test.ts`: `GhCliIssueAdapter preserves decimal REST comment and author IDs above MAX_SAFE_INTEGER` | green |
