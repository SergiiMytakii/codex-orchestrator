---
name: agent-auto
description: Implement one prepared GitHub issue inside the runner-owned worktree and return a typed implementation report.
---

# Agent Auto

Implement one issue end to end inside the prepared worktree. Treat the supplied issue snapshot, frozen acceptance criteria, repository instructions, and runner-provided output schema as authoritative.

Inspect the repository, choose the smallest complete strategy, and follow the
operation-provided package routing resources. Apply the packaged TDD skill for
behavior changes, run focused affected validation, repair failures that are
within the issue scope, and leave the worktree ready for Runner-owned review
and independent acceptance proof. Do not invoke planning or review workflows:
the Runner has already selected and persisted this implementation operation.

The runner owns authorization and every external effect. Do not commit, push, open or edit a pull request, mutate GitHub labels/comments, publish packages, deploy, or use external credentials. Do not copy or print credential bytes or auth/secret paths. If completion depends on a credential, unavailable tool/service, or product decision, return the typed external blocker instead of widening authority.

Return only the JSON object required by the exact output schema supplied by the runner. Do not add prose around the report and do not independently restate or modify its fields.
