# Codex Orchestrator

Codex Orchestrator is a controlled issue runner for turning explicitly authorized GitHub Issues into reviewable Codex work. Its domain is safe autonomous execution, not general AI project management.

## Language

**Codex Orchestrator**:
A runner that executes authorized GitHub Issues through isolated Codex sessions and runner-owned publication controls.
_Avoid_: AI project manager, general Ralph loop engine

**Runner**:
The trusted process that owns issue selection, worktree setup, validation, GitHub mutations, and publication handoff.
_Avoid_: agent, worker

**Agent**:
The Codex session that performs local implementation work inside the runner-prepared workspace.
_Avoid_: runner, publisher

**Agent Attempt**:
One bounded Agent implementation run inside a runner-prepared worktree, including its prompt, report, log, context snapshot, local runner state, and any runner-scheduled Rework Loop retry.
_Avoid_: job, worker attempt

**Issue Work Queue**:
The set of open GitHub Issues whose labels make them visible to the runner.
_Avoid_: backlog, task list

**Eligible Issue**:
An issue that has exactly one autonomous authorization label and no blocking state labels.
_Avoid_: ready ticket

**Loop Policy**:
The project-owned rules for choosing work, retrying blocked attempts, validating results, recording memory, and stopping.
_Avoid_: Ralph policy, autonomy policy

**Issue Selection Policy**:
The deterministic part of the Loop Policy that chooses the next Eligible Issue for the daemon.
_Avoid_: agent prioritization

**Rework Loop**:
A bounded retry cycle where the runner asks the Agent to address machine-checkable blockers from the previous attempt.
_Avoid_: retry forever, restart

**Fresh-Context Review**:
A separate review pass that evaluates the result without inheriting the implementation session's full context.
_Avoid_: self-review

**Review Gate**:
A runner-enforced condition that must pass before a result can be handed off for human review.
_Avoid_: suggestion, guideline

**Acceptance Proof**:
A runner-owned verification phase that gathers evidence that an issue's acceptance criteria are satisfied.
_Avoid_: screenshot check, agent QA

**Adaptive Proof Agent**:
A proof-phase Codex session that can adaptively inspect and drive the running product to produce acceptance evidence, without owning issue state or publication.
_Avoid_: implementation agent, publisher, autonomous QA owner

**Proof Artifact**:
A persisted evidence file from **Acceptance Proof**, such as a screenshot, UI dump, log, smoke output, or proof report.
_Avoid_: attachment, random output

**Proof Report**:
A structured **Acceptance Proof** result that maps acceptance criteria to status, confidence, reasoning summary, and **Proof Artifacts**.
_Avoid_: agent says it passed, screenshot only

**UI Evidence Contract**:
The **Proof Report** section for UI proof that maps artifacts to the exact user workflow, viewport coverage, artifact freshness, visual layout review, and user-facing copy review.
_Avoid_: harness, screenshot exists, visual vibes

**Proof Script Repair**:
A limited proof-phase change to repository-owned verification scripts needed to make **Acceptance Proof** executable.
_Avoid_: feature fix, product code change

**Proof Rework Request**:
A runner-owned handoff back to implementation when **Acceptance Proof** finds that product code or acceptance behavior is incomplete.
_Avoid_: agent label update, hidden retry

**Acceptance Proof Loop**:
A bounded runner-owned cycle that alternates implementation/rework and **Acceptance Proof** until the acceptance criteria pass or the configured iteration limit is reached.
_Avoid_: infinite QA loop, keep trying

**Live Smoke Proof**:
A non-visual **Acceptance Proof** that exercises a running product path and verifies acceptance criteria through observable behavior.
_Avoid_: unit test, static check

**Durable Run Summary**:
A persisted summary of what happened in a run, including decisions, validation, blockers, residual risks, and next action.
_Avoid_: chat transcript

**Policy Suggestion**:
A non-mutating recommendation to update project prompts or configuration based on repeated run evidence.
_Avoid_: automatic policy update

**Runner-Owned Publication Boundary**:
The boundary where the Agent may change local workspace state, while the Runner owns push, pull request creation, labels, and comments.
_Avoid_: human in the loop

**Draft PR Handoff**:
The point where validated runner output is presented to humans as a draft pull request for review.
_Avoid_: completion, merge

## Relationships

- A **Runner** chooses one **Eligible Issue** from the **Issue Work Queue** using the **Issue Selection Policy**.
- A **Loop Policy** contains the **Issue Selection Policy**, **Rework Loop**, **Fresh-Context Review**, **Durable Run Summary**, and **Policy Suggestion** rules.
- An **Agent** works inside a runner-prepared worktree and must not cross the **Runner-Owned Publication Boundary**.
- An **Agent Attempt** is created and recorded by the **Runner**, then evaluated through validation, **Acceptance Proof**, and the **Rework Loop** before any **Draft PR Handoff**.
- A **Review Gate** can block a **Draft PR Handoff**.
- **Acceptance Proof** is a **Review Gate** when issue policy requires live evidence.
- An **Adaptive Proof Agent** runs inside **Acceptance Proof** and produces a **Proof Report** plus **Proof Artifacts** for the **Runner** to validate.
- An **Adaptive Proof Agent** may perform **Proof Script Repair** only in proof-owned paths, but product code changes require a **Proof Rework Request**.
- A **Proof Rework Request** is applied by the **Runner**, not by the **Adaptive Proof Agent**, because labels and comments remain inside the **Runner-Owned Publication Boundary**.
- A **Proof Report** passes only when acceptance criteria are linked to **Proof Artifacts** with high confidence.
- A **Proof Report** that uses UI screenshots or UI dumps must satisfy the **UI Evidence Contract**; screenshot-only proof cannot pass.
- An **Acceptance Proof Loop** must stop at the configured iteration limit.
- A **Live Smoke Proof** uses the same **Acceptance Proof** boundary as visual proof.
- A **Rework Loop** may retry only machine-checkable blockers and must stop at a configured limit.
- A **Fresh-Context Review** reduces Agent self-review bias before **Draft PR Handoff**.
- A **Policy Suggestion** may recommend changing prompts or config, but does not mutate project policy by itself.

## Example Dialogue

> **Dev:** "Should the Agent pick the next most important issue?"
> **Domain expert:** "No. The Runner applies the Issue Selection Policy. The Agent implements the selected issue inside the Runner-Owned Publication Boundary."
>
> **Dev:** "If the Review Gate fails, should we keep looping?"
> **Domain expert:** "Only through the bounded Rework Loop, and only for machine-checkable blockers. Product uncertainty becomes blocked maintainer input."
>
> **Dev:** "Can the proof Agent update labels when the app needs more work?"
> **Domain expert:** "No. The Adaptive Proof Agent writes a Proof Rework Request. The Runner updates issue state because labels are inside the Runner-Owned Publication Boundary."
>
> **Dev:** "Can proof change code?"
> **Domain expert:** "Only Proof Script Repair is allowed during Acceptance Proof. Product code changes go back through implementation and another Acceptance Proof Loop iteration."
>
> **Dev:** "Is a screenshot enough proof?"
> **Domain expert:** "No. The Proof Report must map the screenshot or other Proof Artifacts to acceptance criteria with high confidence."
>
> **Dev:** "Can the proof pass if the screenshot exists but does not show the requested user flow?"
> **Domain expert:** "No. UI proof must satisfy the UI Evidence Contract: exact workflow, relevant viewport, fresh artifact, layout review, and copy review."

## Flagged Ambiguities

- "Ralph loop" was used as a broad automation metaphor. Resolved: in this project the canonical term is **Loop Policy**, and it remains runner-owned rather than LLM-selected.
- "Agent" was used loosely for both the orchestrating process and Codex session. Resolved: **Runner** is trusted orchestration; **Agent** is the local Codex implementation session.
- "Done" was overloaded between local completion and human acceptance. Resolved: the runner produces a **Draft PR Handoff**; merge or release is outside autonomous completion.
- "Subagent for proof" was ambiguous between another implementation Agent and a verification operator. Resolved: the canonical term is **Adaptive Proof Agent**, and it runs inside **Acceptance Proof**.
- "Full shell" during proof could imply publication authority. Resolved: shell access is proof-phase tool access only; issue state and publication remain runner-owned.
- "Update labels" from proof could imply Agent-owned GitHub mutation. Resolved: the **Adaptive Proof Agent** emits a **Proof Rework Request**, and the **Runner** mutates labels or comments.
- "Visual proof" was too narrow for API, worker, CLI, and live smoke acceptance checks. Resolved: **Acceptance Proof** is the umbrella term; visual proof and **Live Smoke Proof** are variants.
- "`visualProof` as a config name predates the broader model. Resolved: **Acceptance Proof** is the canonical domain term; visual-proof configuration can remain as a migration adapter, but screenshot-only fallback is not valid Acceptance Proof.
- "Harness" was used for UI proof quality. Resolved: the canonical domain term is **UI Evidence Contract**; scripts and harnesses are implementation tools that produce evidence for that contract.
