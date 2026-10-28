# ADR 0003: Plan, Implement, Review lifecycle

Status: accepted and implemented by issue #1262.

## Decision

The package executes one open Issue explicitly authorized by the configured auto label. Plan, specification composition, ticket slicing, and multi-ticket coordination remain external. A Run owns one progression:

`implementation → affected checks → Acceptance Proof → Review → publication`

The first Review is complete and covers requirement fidelity plus correctness and repository standards. A Review finding opens one consolidated Implement-owned repair batch. When impact is isolatable, the next fresh affected reviewer receives the previous target identity, candidate repair delta, repaired blocker IDs, direct impact cone, and affected proof: Spec for requirement coverage or behavior, Standards for correctness or mandatory rules, and both when the repair crosses lenses or cannot be isolated. Approval outside that cone is preserved. Semantic cycle, reviewer, and post-PR round counts are correlation data, not stop conditions.

Transport, timeout, launch, observation, report-format, and tooling failures return resumable issue-local outcomes. Each invocation remains bounded. Existing ActiveAttempt, PendingEffect, candidate binding, Checked Change, ProofReceipt, containment, and fast-forward publication mechanisms remain the only durable owners.

## Structural deletion proof

| Responsibility | Before | After |
| --- | --- | --- |
| Planning route | `route-coordinator`, `route-decision`, `route-continuations`, `triage-route` | External Plan; no package runtime owner |
| Specification lifecycle | `spec-coordinator`, `spec-delivery`, `spec-answer` | External planning artifacts; no package runtime owner |
| Validation order | implementation, full Review, checks, proof | implementation, affected checks, proof, complete or targeted Review |
| Semantic stop policy | implementation, reviewer-report, transport, and PR-feedback counters | no numeric semantic stop condition; bounded resumable invocation |
| Repair Review | full rereview | targeted delta and impact cone; complete only when isolation is unavailable |

The cutover deletes seven production route/spec modules, four dedicated route/spec test modules, three packaged operations, and their three output schemas. The generated workflow operation inventory shrinks from six owners to three: implementation, acceptance-proof, and code-review. No replacement coordinator, queue, scheduler, ledger, compatibility alias, or state-machine framework is introduced.

## Consequences

- Planning context or a Parent relationship alone cannot authorize delivery.
- Decision Delta, out-of-scope work, ownership conflict, containment failure, and unprovable required behavior stop at an issue-local boundary.
- Proof receipts and Review refer to the same immutable candidate; candidate drift invalidates affected proof before Review.
- Trusted same-repository PR feedback uses the same targeted repair progression and fast-forward-only publication.
- Legacy run-state bytes containing removed route or specification fields fail the exact schema instead of entering a compatibility path.

## Envelope compatibility amendment (2026-10-05)

The user authorized accepting harmless older journal envelopes while retaining
current execution invariants. `codex-orchestrator.agent-auto-state` versions 2/3
may be read only when every enclosed record validates against the current Run
contract. Reads retain the original bytes; the next ordinary CAS writes the
current envelope. Unknown keys, removed route/spec fields, and missing authority
are still rejected. This does not restore removed execution owners or synthesize
receipts. Rejection returns a bounded actionable reason without raw state contents.

## Global skill authority amendment (2026-10-16)

The implementation owner now performs code changes and configured verification
in one worktree. Runner no longer executes a separate check/repair cycle.
Explicit tests-only issues proceed from that evidence to independent Review;
other required runtime proof retains its protected execution. Exact command,
candidate, authorization, containment and publication guards remain mandatory.

Synchronized global Implement, TDD, Diagnosing Bugs and Code Review define agent
procedures. Local operations, profiles and prompts supply invocation contracts
rather than alternative procedures. Workflow refresh imports their current
sources; an existing Run retains its immutable generation. Reviewers return
current findings and verdicts; Runner owns historical transitions. Report-format
correction preserves completed independent review evidence. This replaces the
separate-check ownership described above without adding a second lifecycle or
cross-version execution compatibility path.

## Single native owner amendment (2026-10-16)

The user authorized completing the single-owner simplification. One native Codex
session executes synchronized Implement, exact configured commands, acceptance
evidence and independent Spec/Standards Review. Runner resumes its persisted UUID
and admits one completion report; it no longer launches separate proof or Review
coordinators or owns semantic finding/repair progression. The Agent retains those
procedures through synchronized global skills, which this change does not edit.

Runner retains authorization, process ownership and cleanup, candidate pins, exact
command receipts, source/reviewer/evidence validation, device leases and durable
fast-forward publication. Android preparation is a finite resource request against
the checked candidate, followed by the same native session. Format correction is
read-only; missing authority, failed checks, invalid evidence and candidate drift
cannot authorize publication. Incompatible older operation generations stop for
fresh trusted authorization before adopting the current generation. No prior
review or proof is converted into new approval.


## Installed SDK host-check amendment (2026-10-20)

For explicitly trusted projects, `runner.checkExecution: "host"` authorizes Runner
to execute configured commands in the issue worktree using ordinary installed
SDKs. The Agent requests this finite action with `checks-request`; Runner retains
complete local output, exit codes and source/policy-bound receipts, then resumes
the same Codex session before Acceptance Proof and independent Review. It uses
existing owned-command fencing, cancellation, timeouts and process cleanup.
An interrupted host action is never automatically replayed. Failures remain
with the same implementation owner for scoped repair or a concrete blocker.
Existing configurations retain worker-side verification. Setup opts into host
checks only with `--flutter-sdk`; it records executable paths in existing check
commands without adding SDK discovery, installation, cloning or cache ownership.

## Full environment inheritance amendment (2026-10-26)

The owner explicitly authorized the full Runner environment for agents and local
checks, including database settings and credentials. Environment keys are no
longer allowlisted or blanked; native shell commands inherit them as well. This
removes environment stripping as a recovery obstacle. Publication authority,
worktree and network policy, process cleanup, required checks, proof and Review
remain enforced independently. Credentials remain forbidden in reports and
published evidence.

Resumable tool/service blockers continue the existing session on the next
bounded invocation rather than requiring manual reauthorization. Credential,
scope and safety boundaries retain their blocking behavior.

## Host checks by default amendment (2026-10-28)

Runner executes configured mandatory checks on the host for every project.
Setup writes `runner.checkExecution: "host"`; parsing an existing configuration
without this field defaults to host execution without rewriting the file.
This supersedes the Flutter-only opt-in and worker-side omission behavior above.
The Agent remains contained; only configured checks use the existing finite
Runner action, inherited environment, receipts and process cleanup.
