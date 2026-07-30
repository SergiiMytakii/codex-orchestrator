# ADR 0001: Runner-owned issue loop

Status: accepted and implemented by the V2 runtime.

## Decision

One trusted Runner owns issue selection, authorization, worktree state, bounded retries, checks, proof validation, GitHub mutations, and publication. A contained Codex Agent implements one selected issue and returns a structured report; it never owns external publication.

Direct `run` and serial `daemon` discovery call the same `runIssue` lifecycle. The initial loop allows at most five implementation cycles, one implementation-report repair, up to four code-review report repairs per target revision, and one separate clean transport retry. A successful direct run may later resume from a frozen trusted PR-feedback batch for at most three separate repair rounds without changing the initial cycle count. Pending-effect intent and exact postcondition reconciliation own effect recovery after interruption.

Durable lifecycle state uses the exact schema identifier
`codex-orchestrator.run-state`. This is a clean cutover with no compatibility
reader, migration, converter, backup, dual-write, version negotiation, or
rollback path. The schema has no version key and rejects unknown keys. Only
absence initializes state; any other non-exact bytes are unsupported and fail
closed without progression effects.

The only lifecycle owners are the `Run`, its optional `ActiveAttempt`, and its
optional `PendingEffect`. The Run owns phase, semantic budgets, and accepted
receipts. `ActiveAttempt` is an operation-neutral kernel for one process and its
result: it accepts identity, process, result, and cleanup observations, but it
does not select product phase, route, policy, retry, budget, or publication
sequence. `PendingEffect` owns at most one unfinished finite local, Git, or
GitHub effect and is settled only after its exact postcondition is observed.

For new direct-route operations, mutable issue-worktree bytes are captured through
a private Git index into one stable tree. A package-owned synthetic commit pins
that tree under `refs/codex-orchestrator/candidates/<runId>/<bindingId>`. Review,
each check, and Acceptance Proof receive separate detached materializations of
that exact commit. The shared index is neither input authority nor a staging
channel for these operations.

Publication persists `{parentSha, treeSha, message, candidateRef}` before it
creates a single-parent commit and compares-and-swaps the intended branch ref.
Recovery observes that exact identity before retrying. Unknown ref-update results
retain the intent and pin and allow observation only; unrelated branch movement
becomes an effect-free safety terminal. A confirmed commit is never pushed while
residual mutable-worktree bytes remain.

## Why

Giving an Agent dynamic authority over priority, stopping, credentials, or publication makes the system difficult to audit and lets repository or prompt content amplify into external writes. Runner ownership keeps each effect finite, testable, and resumable while preserving useful agent autonomy inside the issue worktree.

## Consequences

- Agent tool environments do not inherit GitHub, SSH, npm, or cloud publication
  credentials; shared user-owned Codex auth and same-user local reads remain an
  explicit accepted risk.
- Repository and atomic locks remain finite coordination resources. Candidate
  pins and materializations remain finite content resources, and device leases
  remain finite proof resources. They do not own product progression, semantic
  budget, or a process lifecycle.
- Checks, issue mutations, Git, and GitHub publication remain finite Runner actions.
- Ambiguous ownership or effect outcome fails closed.
- Candidate pins survive pruning and are removed only after state no longer
  references them and every leased process is absent.
- Unsupported durable bytes are retained unchanged for operator action; they
  are not renamed, normalized, backed up, migrated, or used to initialize a
  Run.
- There is no alternate parent-planning or scoped public loop.
- Review-feedback continuation updates only the existing same-repository branch
  and marker-bound draft PR by fast-forward; it never force-pushes or resolves a
  human review thread.
