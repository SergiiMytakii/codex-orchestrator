# Runtime Containment Without Certification

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Authorized runs never require a local containment certificate or certification step. | A missing or stale local certificate blocks every daemon candidate before claim. | `public runIssue reaches review-ready only after ordered durable checks, proof, and publication`; `live smoke starts the packaged runtime without a certification step` | green |
| Worker processes still receive the fixed sandbox arguments, scrubbed environment, denied network, and no external credentials. | Removing certificate bookkeeping accidentally removes the runtime containment controls it used to describe. | `v2-codex-process.test.ts`; `v2-workflow-assets.test.ts`; `v2-contained-report-operation.test.ts` | green |
