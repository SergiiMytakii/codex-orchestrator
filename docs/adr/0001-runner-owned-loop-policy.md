# ADR 0001: Runner-owned issue loop

Status: accepted and implemented by the V2 runtime.

## Decision

One trusted Runner owns issue selection, authorization, worktree state, bounded retries, checks, proof validation, GitHub mutations, and publication. A contained Codex Agent implements one selected issue and returns a structured report; it never owns external publication.

Direct `run` and serial `daemon` discovery call the same `runIssue` lifecycle. The loop allows at most five implementation cycles, one report-only repair, and one separate clean transport retry. Durable intent and postcondition reconciliation own recovery after interruption.

## Why

Giving an Agent dynamic authority over priority, stopping, credentials, or publication makes the system difficult to audit and lets repository or prompt content amplify into external writes. Runner ownership keeps each effect finite, testable, and resumable while preserving useful agent autonomy inside the issue worktree.

## Consequences

- Agent shell commands and native subagents do not inherit parent credentials.
- Checks, device leases, issue mutations, Git, and GitHub publication remain finite Runner actions.
- Ambiguous ownership or effect outcome fails closed.
- There is no alternate parent-planning or scoped public loop.
