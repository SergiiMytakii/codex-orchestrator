# Codex Orchestrator domain

Codex Orchestrator is a controlled GitHub Issue runner. It is not a general project manager.

## Terms

**Runner** — trusted process that owns authorization, worktrees, checks, durable state, proof validation, GitHub state, and publication.

**Agent** — contained Codex process that implements one authorized issue and returns a structured report. It is not a publisher.

**Issue Work Queue** — open issues carrying the configured `auto` label.

**Eligible Issue** — an open issue whose current labels authorize execution and do not conflict with terminal state.

**Run** — one durable `runIssue` lifecycle for one issue. Direct CLI and daemon discovery create the same kind of Run.

**ActiveAttempt** — the Run's optional operation-neutral owner for one contained
process and its result/cleanup observations. It does not choose route, phase,
policy, budget, or publication.

**PendingEffect** — the Run's optional durable intent for one finite local, Git,
or GitHub effect. Recovery settles its exact postcondition before any next
effect is authorized.

**Cycle** — one semantic implementation revision in the Run's existing worktree. Its number is durable correlation data, not an exhaustion budget.

**Validation progression** — the single implementation → affected checks →
Acceptance Proof → Review → publication sequence used for initial delivery and
trusted PR feedback. Initial Review is complete. Isolatable repairs receive a
targeted Review of their delta and direct impact cone while untouched approval is preserved.

**Checked Change** — nominal capability binding exact repository, Git, content, worktree, check, package, and proof-schema state after checks pass.

**Acceptance Proof** — separate contained phase that proves frozen criteria against the Checked Change and returns validated artifacts.

**Proof Artifact** — proof-owned evidence file. Local evidence is never published; publishable evidence obeys the stricter public contract.

**Runner-owned action** — finite operation such as publication, issue mutation, durable ownership, or device leasing that an Agent cannot perform with inherited credentials.

**Resumable intent** — durable record written before an effect and reconciled against its postcondition after restart.

**Safe halt** — fail-closed state used when ownership, containment, process quiescence, or effect outcome cannot be proved. One daemon tick makes at most one bounded process/result/cleanup observation; unresolved ownership returns a resumable projection and never holds the repository loop.

**Review-ready** — terminal successful handoff after checks, proof, and publication. It does not mean merged.

## Relationships

- The Runner chooses an Eligible Issue and owns its Run.
- The Agent implements; the Runner validates and publishes.
- Checks create a Checked Change; Acceptance Proof can accept only that unchanged binding.
- Agent tool environments have no GitHub/npm/SSH/cloud publication authority;
  shared Codex auth and same-user local reads remain an accepted local risk.
- A Run may resume a durable intent but may not invent or repeat an ambiguous external effect.
- Durable state accepts only the exact `codex-orchestrator.run-state` schema.
  Absence initializes it; unsupported bytes fail closed without compatibility,
  migration, backup, dual-write, or progression effects.
- Plan, specification composition, ticket slicing, and graph coordination remain external owners.
- Trusted PR feedback is frozen as Run data with an update epoch and uses the same targeted repair progression; it does not own a second lifecycle or round budget.
- Transport, timeout, report-format, launch, observation, and tooling failures return resumable issue-local outcomes and do not consume semantic repair authority.
