# Issue #1248 compact implementation spec

## Outcome

Make product-answer authority deterministic, immutable, and revalidated before
every successor spec worker and the first implementation launch. Any uncertain
or invalid authority returns the already-published `spec-frozen` projection
without a CAS, budget, attempt, effect, evidence, Git, worktree, or launch.

## Receipt schema

- `question`: exact immutable question receipt, including revision, question
  ID/hash, marker, answer prefix, gaps, and evidence path.
- `canonicalSource` plus sorted `additionalSources`: complete immutable source
  receipts; canonical is the smallest stable comment ID by code-point ordering.
- `duplicateCommentIds`: sorted unique equivalent trusted IDs excluding the
  canonical ID.
- canonical author/comment timestamps and normalized answer/hash.
- exact normalized content/hash, author/timestamps, and current WRITE/ADMIN
  permission receipt for every contributing source.

Equivalent comments authorize one semantic answer and alone populate
`duplicateCommentIds`. Conflicting trusted content remains in the complete
source set and creates a non-accepted answer input for the next immutable question revision;
triage is not rerun. The canonical source remains authority even when an
equivalent duplicate exists, so edit/delete/revocation of any receipt-bound
source fails closed.

## Negative effect matrix

| Observation | Projection | Forbidden changes |
| --- | --- | --- |
| permission lookup throws | existing `spec-frozen` | state/CAS, budgets, attempt/effect, evidence, GitHub write, worktree/candidate, launch |
| edited/deleted/wrong-prefix/wrong-marker | existing `spec-frozen` | same |
| permission revoked or user ID mismatch | existing `spec-frozen` | same |
| equivalent duplicates | one accepted receipt | duplicate semantic budget or worker launch |
| conflicting/insufficient answer | next immutable gap/question | triage rerun or implementation |

## Contract Test Ledger

| Contract ID | Source authority | Approved claim | Primary ticket | Consumers | Owner / seam | Risk it prevents | First test / proof | Valid at SHA | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-ANSWER-001 | #1242 product question; #1248 | Canonical trusted answer is deterministic and records all equivalent IDs | #1248 | spec author/reviewer, implementation authority | `observeSpecAnswer` / `TrustedSpecAnswerV1` | issue comment order changes authority or duplicates spend semantics twice | unordered duplicate production fixture | #1248 checkpoint | green |
| C-ANSWER-002 | #1242 fail-closed authority; #1248 | Answer trust is revalidated before each spec worker and first implementation launch | #1248 | spec coordinator, RunIssue dispatch | pre-launch revalidation seam | edited/revoked/unverifiable answer launches a worker or mutates durable state | permission/edit/revoke boundary matrix | #1248 checkpoint | green |

No waiting state machine, answer lifecycle, retry coordinator, or compatibility
reader is added; the receipt remains Run data.
