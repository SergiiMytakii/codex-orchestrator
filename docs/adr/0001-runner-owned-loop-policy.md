# Runner-owned loop policy

Codex Orchestrator will use Ralph-loop ideas as an internal execution pattern, but the loop remains runner-owned and deterministic where safety or coordination matters. The runner chooses eligible work through project configuration, bounds rework attempts to machine-checkable blockers, records durable run memory, and treats fresh-context review as a gate or advisory signal according to policy; the Agent implements only within the runner-prepared workspace and never owns external publication.

## Considered Options

- Let the Agent choose and mutate the loop dynamically. Rejected because it makes priority, stopping, and publication boundaries harder to test and audit.
- Keep the existing issue-number polling model only. Rejected because it does not capture the accepted "next most important work" behavior from the loop model.
- Make the Runner own loop policy while prompts explain project workflow. Accepted because it keeps safety and coordination enforceable while preserving project-specific flexibility.

## Consequences

The public product remains a controlled GitHub Issues runner, not a general AI project manager. Future implementation should add loop capabilities through config, prompts, review gates, and reports without giving the Agent authority over GitHub publication or irreversible actions.
