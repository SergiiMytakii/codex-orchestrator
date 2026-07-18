## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| A declared dependency skill and operation resource are present in the exact operation snapshot closure. | Fresh local routing or TDD owners are packaged but ignored by the executing operation. | `test/v2-workflow-import.test.ts`: `workflow source v2 binds dependency skills and keeps evals outside runtime operation closure` | green |
| Cross-skill and skill-local eval suites are packaged, schema-checked, owner-bound, and excluded from runtime operation snapshots. | Evals are silently dropped, malformed, or consume worker context without being executed. | `test/v2-workflow-import.test.ts`: source-v2 eval assertions and invalid-eval cases | green |
| New workflow generations expose one `code-review` operation with cleanup as a lens while pinned V1 generations remain readable. | New runs retain obsolete duplicate review tracks or an upgrade strands an active pinned run. | `test/v2-workflow-assets.test.ts` V1 compatibility fixture plus V2 production binding assertions | green |
| One refresh command syncs, verifies, and runs focused workflow contract tests; release publication repeats offline verification and the full suite. | Maintainers publish stale or contract-invalid generated assets after local skill changes. | `npm run refresh:workflow`; stale-source and package tests; `.github/workflows/npm-publish.yml` | green |
