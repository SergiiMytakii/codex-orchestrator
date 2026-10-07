# Symphony compared with Codex Orchestrator

## Decision To Unblock

Determine whether OpenAI Symphony overlaps with, supersedes, or offers useful direction for Codex Orchestrator. Symphony was inspected at default-branch commit [`8001b52`](https://github.com/openai/symphony/tree/8001b52e3062495a16e520e4ceaf8f9de868c4d0) (2026-08-12). The local baseline is committed Codex Orchestrator 2.0.18, commit `94d2ab8` (2026-08-19). Uncommitted local changes were excluded.

## Short Answer

They share the same base pattern: discover authorized tracker work, isolate it in a per-issue workspace, run Codex unattended, reconcile state, and hand work to a human. They optimize for different goals.

Symphony is the broader orchestration platform: multiple trackers, concurrent and remote workers, hot-reloaded workflow policy, provider-native tools, and a dashboard/API. Codex Orchestrator is the stricter GitHub delivery appliance: one issue at a time, immutable candidate identity, durable effect reconciliation, Runner-owned credentials and publication, and mandatory checks, proof, and independent review before a draft PR.

## Findings

| Dimension | Symphony | Codex Orchestrator | Practical advantage |
| --- | --- | --- | --- |
| Product shape | Draft language-neutral specification plus experimental Elixir/OTP reference service | Released Node/TypeScript npm package with fixed V2 lifecycle | Symphony is easier to port and extend; Orchestrator is a more concrete packaged delivery contract |
| Work source | Adapter model; current reference includes Linear, GitHub Issues, GitLab, Jira Cloud, and Asana | GitHub Issues only, authorized by exact labels and repository policy | Symphony for heterogeneous organizations; Orchestrator for deep GitHub specialization |
| Scheduling | Concurrent dispatch with global, per-state, and remote-host limits | Serial daemon; direct `run` and daemon share one lifecycle | Symphony for throughput; Orchestrator for fewer concurrency interactions |
| Workspace | Deterministic per-issue directory, populated and managed through configurable hooks; optional SSH workers | Git worktree pinned to an immutable fetched base SHA | Symphony for arbitrary bootstrap/deployment models; Orchestrator for reproducible Git delivery |
| Workflow ownership | `WORKFLOW.md` YAML plus prompt controls runtime settings, hooks, and agent behavior; hot reload keeps last known-good config | Exact JSON schema plus packaged fixed operations: implementation, checks, Acceptance Proof, Review, publication | Symphony for policy freedom; Orchestrator for deterministic gates and less prompt-owned authority |
| Agent protocol | Codex app-server, multi-turn session, provider-native dynamic tracker tools | Bounded Codex CLI processes with operation-specific reports | Symphony for interactive long-lived work; Orchestrator for finite auditable operations |
| Tracker and publication writes | Core is mainly scheduler/reader; workflow agent usually performs ticket and PR actions through tools | Trusted Runner alone owns labels, comments, commits, pushes, draft PR creation, and read-back | Orchestrator has the stronger least-authority publication boundary |
| Safety defaults | Workspace-write sandbox, approval/rule/elicitation rejection, token scrubbing, canonical path and symlink checks; posture remains configurable and targets trusted environments | Fixed worker network denial, no external writes, scrubbed publication credentials, denied paths/commands, Runner validation of every effect | Orchestrator for fail-closed delivery; Symphony for deployer-controlled posture |
| Quality gates | Defined by repository workflow; example workflow can require CI, review feedback, media, and landing | Structural lifecycle requires affected checks, separately produced Acceptance Proof, independent Review, and immutable candidate freshness | Orchestrator: gates cannot be silently weakened by prompt wording |
| Crash recovery | Scheduler, retry, and blocked details are primarily in memory; restart reconstructs eligibility from tracker/filesystem and reuses workspaces | Durable run record stores base/candidate identity, attempts, pending effects, checks, proof, review, and terminal evidence; effects are observed before retry | Orchestrator for crash consistency and ambiguous-effect avoidance |
| Human interaction | Workflow-defined states such as Human Review/Rework/Merging; blocked operator requests exposed in memory/API/dashboard | Structured `review-ready`, `repair-ready`, `blocked`, and transport outcomes; trusted PR feedback can resume the same branch/PR | Symphony is more flexible; Orchestrator provides stricter continuation identity |
| Observability | Structured logs, terminal status, token/rate-limit metrics, optional Phoenix dashboard and JSON API | Structured CLI JSON, `doctor`, `status`, durable evidence artifacts | Symphony for fleet operations; Orchestrator for forensic per-run evidence |
| Mobile/UI proof | Workflow can direct agents to produce walkthrough media | Optional Runner-owned Android emulator recipe binds APK and artifacts to checked change | Orchestrator has a stronger built-in Android evidence boundary |
| Merging | Example workflow supports an agent-driven landing phase after human approval; not required by core spec | Stops at draft PR and human review; does not merge | Symphony for fuller issue-to-merge automation; Orchestrator for conservative handoff |
| Maturity signal | Explicit engineering preview; Draft v1 spec; latest release v0.0.2 trails current `main` | Package 2.0.18 with strict schema and extensive contract tests | Neither should be judged by version alone; Symphony’s own docs explicitly warn it is prototype software |

### What is genuinely similar

- Long-running polling mode plus isolated workspaces.
- Issue eligibility, claim ownership, reconciliation, retry, and cancellation when tracker state changes.
- Repository-owned policy and unattended Codex execution.
- Credential scrubbing and workspace containment rather than assuming the coding agent should hold every external credential.
- Human-review handoff as a valid successful outcome.

### Architectural conclusion

Symphony does not supersede Codex Orchestrator. It sits one abstraction level higher and keeps much more delivery policy in the workflow prompt and agent tools. Codex Orchestrator encodes one narrower delivery policy as trusted runtime logic.

The most valuable Symphony ideas to consider independently are multi-tracker adapters, bounded parallel dispatch, app-server sessions, hot workflow reload, and a lightweight dashboard. They should not be copied as one bundle: adding concurrency or tracker-native agent writes without preserving pending-effect reconciliation and immutable candidate binding would weaken Orchestrator’s main advantage.

## Primary-source ledger

| Claim | Primary Source | Version / Date | Confidence |
| --- | --- | --- | --- |
| Symphony is a scheduler with per-issue workspaces and authoritative in-memory state | [SPEC: problem, goals, architecture](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md#L17-L100) | Draft v1, commit 2026-08-12 | High |
| It supports bounded concurrency, reconciliation, and exponential-backoff retries | [SPEC: dispatch and retry](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md#L737-L828) | commit 2026-08-12 | High |
| Current adapters include five external trackers and provider-native tools | [Elixir README](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/README.md#L14-L35) | commit 2026-08-12 | High |
| Workflow policy is repository-owned and hot reloaded | [SPEC: workflow reload](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md#L557-L574) | commit 2026-08-12 | High |
| Restart does not restore exact in-memory scheduler state | [SPEC: goals and recovery boundary](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/SPEC.md#L45-L58) | commit 2026-08-12 | High |
| Safety is configurable and the reference is explicitly a trusted-environment preview | [Project README](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/README.md), [Elixir README safety defaults](https://github.com/openai/symphony/blob/8001b52e3062495a16e520e4ceaf8f9de868c4d0/elixir/README.md#L146-L165) | commit 2026-08-12 | High |
| Orchestrator owns a fixed issue-to-draft-PR delivery lifecycle | Local `README.md`, `src/v2/run-issue.ts`, and `docs/adr/0003-plan-implement-review-lifecycle.md` | 2.0.18, commit 2026-08-19 | High |
| Orchestrator persists and reconciles exact pending publication effects | Local `src/v2/run-store.ts`, `src/v2/pending-effect-settlement.ts`, and `docs/adr/0001-runner-owned-loop-policy.md` | 2.0.18, commit 2026-08-19 | High |
| Orchestrator workers cannot publish and use fixed network-denied containment | Local `src/v2/containment.ts` and `docs/adr/0001-runner-owned-loop-policy.md` | 2.0.18, commit 2026-08-19 | High |

## Repository Implications

This comparison supports retaining Codex Orchestrator’s current product identity: a controlled GitHub delivery runner, not a general workflow engine. If broader scale is desired, evaluate Symphony-inspired capabilities separately in this order: operator observability, app-server protocol, tracker adapter seam, then concurrency. Durable effect ownership, immutable candidate/proof identity, and Runner-only publication should remain non-negotiable constraints.

## Conflicts And Unknowns

- Symphony’s `main` is newer than its latest release; this comparison describes commit `8001b52`, not only v0.0.2.
- The language-neutral spec permits implementation-defined security. Safety conclusions refer to the current Elixir reference implementation, not every possible Symphony implementation.
- Symphony can encode elaborate checks, PR feedback, and merging in `WORKFLOW.md`; those are prompt/workflow capabilities, not fixed guarantees of the core scheduler specification.
- No live fault injection or credential-boundary test was run for either package. This is a source-level architectural comparison.
- The local checkout had unrelated uncommitted edits in issue-check/run files and tests. They were preserved and excluded from claims about released 2.0.18 behavior.
