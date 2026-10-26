# Codex Orchestrator domain

Codex Orchestrator is a controlled GitHub Issue runner. It is not a general project manager.

## Terms

**Runner** — trusted process that owns authorization, worktrees, process ownership, durable state, evidence admission, GitHub state, and publication.

**Agent** — contained Codex session that implements and verifies one authorized issue, gathers acceptance evidence, obtains independent Review, and returns its completion report. It is not a publisher.

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

**Validation progression** — the single implementation with verification →
required runtime proof → Review → publication sequence used for initial delivery and
trusted PR feedback. Initial Review is complete. Isolatable repairs receive a
targeted Review of their delta and direct impact cone while untouched approval is preserved.

**Checked Change** — nominal capability binding exact repository, Git, content, worktree, check, package, and proof-schema state after checks pass.

**Acceptance Proof** — evidence for frozen criteria gathered by the Agent and admitted by the Runner. Device proof requires protected runtime resources and leases.

**Proof Artifact** — proof-owned evidence file. Local evidence is never published; publishable evidence obeys the stricter public contract.

**Runner-owned action** — finite operation such as publication, issue mutation, durable ownership, or device leasing reserved for the Runner. Inherited credentials do not transfer that authority to an Agent.

**Resumable intent** — durable record written before an effect and reconciled against its postcondition after restart.

**Safe halt** — fail-closed state used when ownership, containment, process quiescence, or effect outcome cannot be proved. One daemon tick makes at most one bounded process/result/cleanup observation; unresolved ownership returns a resumable projection and never holds the repository loop.

**Review-ready** — terminal successful handoff after checks, proof, and publication. It does not mean merged.

## Relationships

- The Runner chooses an Eligible Issue and owns its Run.
- The Agent owns implementation, verification decisions, Acceptance Proof and independent Review. With explicit `runner.checkExecution: "host"`, Runner executes configured checks and resumes that same Agent before proof and Review; otherwise the Agent executes them in its sandbox. Runner admits the unchanged result and publishes.
- Checks create a Checked Change; Acceptance Proof can accept only that unchanged binding.
- Agents and host checks inherit the full Runner environment, including
  credentials; publication authority remains with the Runner.
- A Run may resume a durable intent but may not invent or repeat an ambiguous external effect.
- Durable Run records must satisfy the current execution contract. Legacy envelopes
  may carry those same records, but obsolete execution fields and missing authority
  cannot authorize continuation. Unsupported state remains unchanged and blocks progression.
- Plan, specification composition, ticket slicing, and graph coordination remain external owners.
- Trusted PR feedback is frozen as Run data with an update epoch and resumes the same Agent; it does not own a second lifecycle or round budget.
- Transport, timeout, report-format, launch, observation, and tooling failures return resumable issue-local outcomes and do not consume semantic repair authority.
