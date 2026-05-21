# Symphony vs codex-orchestrator

Date: 2026-05-21

Compared snapshots:

- `openai/symphony`: `2c18518` (`2026-05-20`, `Update README.md`)
- `SergiiMytakii/codex-orchestrator`: `66a9ac6` (`2026-05-20`, `Release 0.1.34 adaptive proof agent`)

## Short Read

Both projects solve the same class of problem: they turn issue-tracker work into
isolated Codex execution runs so engineers can manage work items instead of
manually supervising every agent session.

The core difference is ownership. Symphony is a general service spec plus an
Elixir reference daemon that delegates most tracker/PR workflow behavior to the
agent through `WORKFLOW.md`. `codex-orchestrator` is a GitHub-native runner that
keeps labels, issue state, validation gates, proof policy, branch push, and draft
PR publication under runner control.

## Shared Concepts

| Area | Symphony | codex-orchestrator |
| --- | --- | --- |
| Work queue | Linear project states | GitHub Issues labels |
| Execution unit | One Linear issue | One GitHub issue, or parent issue tree |
| Isolation | Per-issue workspace directory | Per-issue git worktree and branch |
| Policy location | Repo-owned `WORKFLOW.md` front matter + prompt body | Repo-owned `.codex-orchestrator/config.json` + bundled/local workflow prompts |
| Runner mode | Long-running daemon with poll/retry/reconcile loop | `status`, `run`, and `daemon`; daemon can recover interrupted handoff |
| Codex invocation | Codex app-server over stdio, multi-turn thread | Codex CLI `exec` subprocess per runner phase |
| Human gate | Workflow-defined states such as `Human Review` | Draft PR handoff with `agent:review`; no auto-merge |
| Observability | Structured logs, JSON API, Phoenix LiveView dashboard | CLI status, lifecycle JSONL events, durable run summaries, issue comments |
| Concurrency | Global and per-state agent limits; optional SSH workers | Bounded scoped issue batches by declared ownership; child waves by dependency |
| Recovery | Tracker/filesystem-driven restart; in-memory scheduler state is not restored | Durable local runner state, recovery entries, completed-report based handoff recovery |

## Symphony Strengths

- Strong service shape: `SPEC.md` defines a portable, language-agnostic
  scheduler with explicit layers for workflow loading, config, tracker,
  orchestration, workspace management, agent runner, and observability.
- Codex app-server integration is deeper than a CLI subprocess. It can keep one
  Codex thread alive across multiple turns, stream events, track token usage and
  rate-limit snapshots, and handle dynamic tools.
- Operator visibility is first-class. The Elixir implementation includes a
  Phoenix LiveView dashboard and JSON API for running sessions, blocked sessions,
  retries, token totals, rate limits, and per-issue details.
- Runtime workflow reload is a central design point. `WORKFLOW.md` changes are
  intended to apply to future dispatch without restarting the service.
- It has a cleaner distributed-worker story. Local workers and SSH workers use
  the same app-server path, with representative live E2E coverage for SSH
  transports.
- The Linear workpad model is powerful for long tasks: one persistent comment is
  treated as the live scratchpad, acceptance checklist, validation record, and
  handoff surface.

## Symphony Weaknesses

- It is explicitly preview/prototype software, and the repo recommends building
  a hardened implementation from the spec for serious use.
- The reference implementation is tightly centered on Linear. The spec names
  Linear as the tracker for v1, while GitHub issue/PR behavior is left to
  workflow prompt/tooling conventions.
- Ticket writes, PR links, comments, and state transitions are typically agent
  actions rather than runner-owned actions. That makes the system flexible, but
  reduces the hard boundary between agent output and external publication.
- There is no built-in equivalent to our machine-readable Acceptance Proof
  contract: no runner-validated criterion map, artifact refs, high-confidence
  gate, proof-phase diff classification, or rework loop based on a validated
  proof report.
- Restart recovery deliberately avoids a durable orchestrator database. That is
  simpler, but blocked entries are in memory only and can be lost on restart.
- The workflow file can become very large because it combines runtime config,
  tracker status routing, skills guidance, validation policy, PR feedback
  protocol, and handoff rules in one prompt surface.

## codex-orchestrator Strengths

- GitHub-native ownership is much stricter. The runner itself owns issue labels,
  claims, blocked/review state, comments, branch creation, push, draft PR
  creation, and recovery handoff.
- The package/repo-policy split is practical for reuse. The npm package carries
  orchestration logic and bundled workflow prompts; each target repo keeps its
  own `.codex-orchestrator/` policy.
- Parent planning is more productized. `agent:plan-auto` can create/update the
  parent PRD, generate child issues, review the breakdown, triage children, run
  dependency-aware child waves, and open one integration PR.
- Acceptance Proof is a unique hard gate. The runner can run a separate proof
  phase, require high-confidence artifact-backed criteria, block malformed or
  low-confidence proof, reject product-code changes made during proof, and loop
  back through implementation when proof requests rework.
- Review gates are explicit policy, not only prompt convention: TDD evidence,
  code review, cleanup review, configured checks, deny rules, and proof gates
  all affect publishability.
- Durable evidence is stronger: prompts, reports, logs, context snapshots,
  lifecycle events, local state, and run summaries are written under runner
  control.
- The safety posture is conservative by default: no auto-merge, publication
  boundaries are runner-owned, secret files are denied, deploy/release actions
  are blocked by policy unless explicitly handled.

## codex-orchestrator Weaknesses

- Observability is currently operator-CLI first. `status --json`, lifecycle
  JSONL, and issue comments are useful, but there is no live dashboard comparable
  to Symphony's Phoenix UI.
- Codex integration is less interactive. CLI `exec` phases are easier to reason
  about, but they do not expose the same live token/rate-limit stream or
  long-lived app-server thread semantics.
- Runtime policy reload is less service-like. Config is read per command/run,
  but a running daemon does not have Symphony's explicit live reload contract for
  polling, concurrency, prompts, hooks, and future dispatch.
- Distributed workers are not a first-class concept. Work is isolated locally in
  git worktrees; remote SSH worker pools would need new runner architecture.
- The project is GitHub-centric. That is a strength for current use, but less
  portable than Symphony's language-agnostic service spec and tracker abstraction.
- The current concurrency model is intentionally cautious: scoped issue batches
  require non-overlapping ownership metadata, and daemon concurrency is capped
  tightly. This reduces collision risk but limits throughput.

## Unique Features

### Symphony

- Language-agnostic orchestration spec intended for independent implementations.
- Codex app-server client with streaming session updates.
- Dynamic `linear_graphql` tool injection into Codex app-server sessions.
- Phoenix LiveView dashboard plus JSON observability API.
- Token and rate-limit accounting surfaced at runtime.
- Runtime `WORKFLOW.md` reload.
- Optional SSH worker execution with live E2E coverage.
- Multi-turn continuation loop while the Linear issue remains in an active
  state.

### codex-orchestrator

- GitHub label state machine for `agent:auto`, `agent:plan-auto`, `agent:child`,
  `agent:running`, `agent:blocked`, and `agent:review`.
- Runner-owned draft PR publication and no auto-merge boundary.
- Parent issue-tree planning, child issue persistence, dependency waves, and
  integration branch/PR flow.
- Adaptive Acceptance Proof with validated JSON report, artifacts, confidence
  checks, rework requests, and forbidden product-code diff detection.
- Fresh-context review hook, durable run summaries, context snapshots, and
  lifecycle event JSONL.
- Package-bundled workflow prompts installed into target repos by `setup`.
- Configured deny rules for secrets, destructive persistence operations, and
  production deploy/release boundaries.
- Worktree cleanup and completed-run recovery paths.

## What We Should Consider Borrowing

1. Add a small observability surface before building more orchestration logic:
   a local JSON endpoint or static dashboard over existing status/state/events
   would give most of Symphony's operator visibility without changing execution
   semantics.
2. Explore Codex app-server as an optional adapter, not a replacement for the
   current CLI adapter. The useful pieces are live events, token accounting,
   request/approval handling, and long-lived proof/implementation sessions.
3. Define a cleaner runtime reload contract for daemon mode: which config fields
   apply on the next tick, which require restart, and how invalid reloads are
   surfaced without stopping active runs.
4. Keep remote workers as a separate architecture decision. Symphony proves the
   shape, but adopting it would affect worktree ownership, auth, artifacts,
   cleanup, and proof file collection.
5. Steal the "single live workpad" idea selectively for issue comments. Our
   runner-owned comments are safer, but a stable comment ID updated across a run
   could reduce noisy issue history.

## What We Should Not Borrow Blindly

- Do not move GitHub state transitions, PR creation, or publication decisions
  back into agent prompt convention. That would weaken the strongest boundary in
  `codex-orchestrator`.
- Do not collapse config, policy, and long-form workflow instructions into one
  giant file. Our split between `.codex-orchestrator/config.json` and workflow
  prompts is easier to validate.
- Do not treat dashboard visibility as proof. Symphony's observability is
  operator-facing; Acceptance Proof still needs runner-validated criteria and
  artifacts.
- Do not adopt high concurrency without ownership-aware batching and recovery.
  Throughput is useful only if publication remains safe.

## Bottom Line

Symphony is stronger as an orchestration service blueprint: app-server-native,
observable, reloadable, and ready for remote worker pools. `codex-orchestrator`
is stronger as a GitHub publication and review-control runner: stricter
state ownership, issue-tree execution, durable recovery, and runner-owned
Acceptance Proof.

The highest-leverage convergence path is not to replace our model with
Symphony's. It is to keep runner-owned GitHub publication and proof gates, while
borrowing Symphony's app-server observability, dashboard/API shape, runtime
reload semantics, and eventually remote worker abstraction.
