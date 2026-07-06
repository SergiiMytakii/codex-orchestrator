## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Review-ready terminal handoff pushes the branch, finds or creates the draft PR, verifies refs, then removes `agent:running`, adds `agent:review`, and posts one report comment. | Parent or scoped issue could be marked review-ready before the draft PR exists or points at the intended refs. | `review-ready terminal outcome pushes and verifies draft PR before issue labels and comment` via `npm test` | green |
| Blocked terminal handoff removes `agent:running`, adds `agent:blocked`, and honors marker-based idempotency before posting another blocked report. | Recovery and parent hard-block paths could duplicate comments or drift label/comment order. | `blocked terminal outcome preserves marker idempotency and does not post duplicate comments` via `npm test` | green |
| Promotion-requested scoped handoff uses the blocked label while preserving the `promotion-requested` result and report body. | Promotion requests could accidentally become review-ready or lose maintainer-action signaling. | `promotion-requested terminal outcome uses blocked label and posts promotion report` via `npm test` | green |
| Child review-ready handoff removes `agent:running`, adds `agent:review`, posts the child report, then runs state cleanup. | Child runner state could be removed before GitHub terminal evidence is durable. | `comment-only review-ready terminal outcome supports child handoff cleanup after comment` via `npm test` | green |
