# Codex Orchestrator domain

Codex Orchestrator is a controlled GitHub Issue runner. It is not a general project manager.

## Terms

**Runner** — trusted process that owns authorization, worktrees, checks, durable state, proof validation, GitHub state, and publication.

**Agent** — contained Codex process that implements one authorized issue and returns a structured report. It is not a publisher.

**Issue Work Queue** — open issues carrying the configured `auto` label.

**Eligible Issue** — an open issue whose current labels authorize execution and do not conflict with terminal state.

**Run** — one durable `runIssue` lifecycle for one issue. Direct CLI and daemon discovery create the same kind of Run.

**Cycle** — one bounded implementation attempt in the Run's existing worktree.

**Checked Change** — nominal capability binding exact repository, Git, content, worktree, check, package, and proof-schema state after checks pass.

**Acceptance Proof** — separate contained phase that proves frozen criteria against the Checked Change and returns validated artifacts.

**Proof Artifact** — proof-owned evidence file. Local evidence is never published; publishable evidence obeys the stricter public contract.

**Runner-owned action** — finite operation such as publication, issue mutation, durable ownership, or device leasing that an Agent cannot perform with inherited credentials.

**Resumable intent** — durable record written before an effect and reconciled against its postcondition after restart.

**Waiting question** — immutable route-bound GitHub question published by the Runner after an approved `awaiting-user` decision.

**Trusted answer** — unedited exact-prefix answer posted after its question by an identity with current repository WRITE or ADMIN permission and frozen into the Run before rerouting.

**Safe halt** — fail-closed state used when ownership, containment, process quiescence, or effect outcome cannot be proved.

**Review-ready** — terminal successful handoff after checks, proof, and publication. It does not mean merged.

## Relationships

- The Runner chooses an Eligible Issue and owns its Run.
- The Agent implements; the Runner validates and publishes.
- Checks create a Checked Change; Acceptance Proof can accept only that unchanged binding.
- Agent tool environments have no GitHub/npm/SSH/cloud publication authority;
  shared Codex auth and same-user local reads remain an accepted local risk.
- A Run may resume a durable intent but may not invent or repeat an ambiguous external effect.
- A waiting Run resumes only through its matching marker and Trusted Answer, then reruns triage before any product implementation.
- Five failed implementation cycles exhaust the Run without publication.
