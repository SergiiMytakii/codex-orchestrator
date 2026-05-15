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
- A **Review Gate** can block a **Draft PR Handoff**.
- A **Rework Loop** may retry only machine-checkable blockers and must stop at a configured limit.
- A **Fresh-Context Review** reduces Agent self-review bias before **Draft PR Handoff**.
- A **Policy Suggestion** may recommend changing prompts or config, but does not mutate project policy by itself.

## Example Dialogue

> **Dev:** "Should the Agent pick the next most important issue?"
> **Domain expert:** "No. The Runner applies the Issue Selection Policy. The Agent implements the selected issue inside the Runner-Owned Publication Boundary."
>
> **Dev:** "If the Review Gate fails, should we keep looping?"
> **Domain expert:** "Only through the bounded Rework Loop, and only for machine-checkable blockers. Product uncertainty becomes blocked maintainer input."

## Flagged Ambiguities

- "Ralph loop" was used as a broad automation metaphor. Resolved: in this project the canonical term is **Loop Policy**, and it remains runner-owned rather than LLM-selected.
- "Agent" was used loosely for both the orchestrating process and Codex session. Resolved: **Runner** is trusted orchestration; **Agent** is the local Codex implementation session.
- "Done" was overloaded between local completion and human acceptance. Resolved: the runner produces a **Draft PR Handoff**; merge or release is outside autonomous completion.
