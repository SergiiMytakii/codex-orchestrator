# Coding Skill Routing

Global coding skills own reusable engineering process. Local repo skills and docs own repository-specific facts.

The single personal-skill root is `../../skills` for root
agents and subagents in every repository. Invocation policy lives in each
skill's `agents/openai.yaml`; do not encode a second policy in `SKILL.md`
frontmatter or copy global workflow skills into repositories.

Use this routing policy before adding more instructions to a global skill.

## Ownership

Global skills own reusable process:

- planning, external research, diagnosis, implementation, review, cleanup,
  smoke-test, and commit workflows
- reusable gates such as TDD, contract test ledger, confidence handling, evidence standards, and review order
- deterministic fact collection that does not encode product knowledge
- progressive references for framework-agnostic or broadly reusable guidance

Local repo skills and docs own repository facts:

- package manager and project commands
- domain language, product behavior, fixtures, and smoke scenarios
- environment variables, credential sources, service topology, and deployment assumptions
- local architecture decisions, ADRs, and repo-specific validation rules

Do not move those local facts into a global skill.

## Execution Modes

- **Inline:** root performs non-review work. This is the default for small and ordinary authoring or implementation work.
- **Delegate:** use one named custom agent when independent review or deeper isolated analysis is required.
- **Parallel:** use multiple agents only for independent tracks with disjoint responsibilities.

Automatic routing never authorizes automatic spawning. Spawn only when the user, an invoked skill, or applicable repo instructions authorize delegation. Root owns decisions, integration, user communication, and the critical path.

Root must never perform review inline. Every review gate launches the reviewer
role selected by the review profile. Because `agents.max_depth = 1`, a review
Adapter executes inline only after it is already inside that assigned reviewer
child; this is child execution, not root self-review.

## Platform UI QA Routing

Load the platform QA skill first; use `$flutter-attach-session` only as the
runtime ownership and reload/restart layer. Detailed safety rules live in
[`tool-usage.md`](tool-usage.md).

- Android: `$flutter-android-debug` plus
  `test-android-apps:android-emulator-qa`.
- iOS: `$flutter-ios-debug`.
- Live, IDE-owned, machine-owned, or ambiguous runtimes are user-owned. UI
  inspection alone never authorizes replacement, termination, install, or launch.

## Named Agent Profiles

| Role | Contract |
| --- | --- |
| `explorer_quick` | Mechanical inventory of files, symbols, usages, tests, and registrations |
| `explorer_fast` | Bounded cross-module execution tracing with file:symbol evidence |
| `analyst_deep` | Read-only architecture, causal, contract, and root-cause synthesis |
| `researcher_standard` | Read-only external primary-source research with claim-level citations |
| `reviewer_fast` | Fast independent review for `simple` profiles |
| `reviewer_standard` | Independent review for `medium` profiles |
| `reviewer_deep` | Deep independent review for `high` profiles and security |
| `implementer_standard` | Write-capable worker for one approved bounded ticket slice |
| `implementer_deep` | Write-capable worker for a rare isolated slice with material technical uncertainty |

The role files in `agents/*.toml` own model, effort, nickname, and instructions.
Skills request exact role names and never override model or effort. Artifact and
implementation review Modules own Full/Closure topology; Approval Packet review
owns its axis split. Analysis routing remains independent of review profile.

## Routing Table

| Skill or workflow | Default mode | Named-agent routing |
| --- | --- | --- |
| `$grilling` | Root owns the interactive session | Optional `explorer_fast` for bounded evidence and `analyst_deep` for proven ambiguity; children never conduct the user dialogue |
| `$codebase-design` | Bounded reference lens for a named Module Interface or Seam; never a standalone scan, mutation, or implementation workflow | None for bounded reference use; Design It Twice runs 3+ isolated `analyst_deep` children in parallel for a selected consequential candidate, with any inline fallback labelled non-independent |
| `$research` | Root prepares the Research Capsule, verifies decision-driving claims, and saves one artifact | One `researcher_standard`; root may use the documented inline fallback when the role is unavailable |
| `$plans-maker` | Explicit-only root-authored Architecture RFC | Profile-selected reviewer topology from `artifact-review-loop.md`; optional `analyst_deep` only for unresolved architecture |
| `$plan-review` | Inline only inside the assigned reviewer child | Root launches the profile-selected reviewer |
| `$implementation-spec-maker` | Root authors inline | Profile-selected reviewer topology from `artifact-review-loop.md`; optional `analyst_deep` only for proven ambiguity |
| `$implementation-spec-review` | Inline only inside the assigned reviewer child | Root launches the profile-selected reviewer |
| `$to-spec` | Root authors a human-readable PRD inline; combined flow keeps it in context until final publication | Standalone reviewed PRD uses `$tickets-breakdown-review` PRD-only mode |
| `$to-tickets` | Root drafts the ticket graph, obtains one approval, and publishes generated children directly in final AFK/HITL states | One direct low-risk ticket skips independent review; other packets use `$tickets-breakdown-review` |
| `$tickets-breakdown-review` | Root prepares and aggregates only when the caller's review gate applies | One profile-selected child covers both axes by default; two `reviewer_deep` children only when both axes are independently high-risk; PRD-only uses one child |
| `$triage` | Root verifies raw incoming issues or configured external PRs and prepares durable briefs | No implementation worker; never post-processes generated `$to-tickets` children |
| `$small-task-implementer` | Always inline after Fit Gate | None by default |
| `$spec-implementer` | Inline for compact and normal specs | Profile-selected reviewers at required checkpoints; parallel workers only for an explicit multi-agent spec |
| `$tdd` | Inline in the active implementation flow | Never spawns its own agent |
| `$code-debugger` | Inline for reproduced, bounded bugs | `analyst_deep` only while causal or contract ambiguity remains unresolved |
| `$bug-root-cause-explainer` | Root coordinates read-only diagnosis | Optional `explorer_fast`; `analyst_deep` for ambiguous causal synthesis |
| `$diagnosing-bugs` | Root owns the feedback loop | Optional `explorer_fast`; no implementation worker |
| `$code-review` | Root prepares and aggregates | One reviewer for `simple`/`medium`; two disjoint `reviewer_deep` tracks for `high` |
| `$cleanup-review` | Root prepares and integrates | One profile-selected reviewer child |
| `$security-best-practices` | Root coordinates explicit security review | One `reviewer_deep` |
| `$improve-codebase-architecture` | Inline for bounded analysis | `analyst_deep` only for broad or ambiguous architecture |
| `$commit` | Inline | No agent unless another policy already requires review |
| `$tickets-orchestrator` | Root owns ticket graph, user decisions, integration, and delivery | One ready ticket stays root-owned; launch at most two independent disjoint implementers; prepare later tickets only after blockers settle; reuse issue authority or route through maker/spec Modules |
| `$smoke-test-orchestrator` | Inline unless the scenario explicitly requires workers | Follow the scenario's disjoint ownership contract |

## Artifact Review Loop

Plan and implementation-spec authoring use
[`artifact-review-loop.md`](artifact-review-loop.md) as the single review Module.
It owns artifact risk, scope conservation, reviewer topology, and outcome
mapping while applying [`review-protocol.md`](review-protocol.md) for common
review mechanics. Maker skills supply authority and repairs; review Adapters
supply artifact-specific lenses and output.

## Implementation Review Loop

Approved implementation-spec execution uses
[`implementation-review-loop.md`](implementation-review-loop.md) as the single
review Module. It owns approved-spec authority, durable state, whole-spec
topology, validation reuse, gate ordering, final coverage, and audit epochs while
applying [`review-protocol.md`](review-protocol.md). `spec-implementer`, review
Adapters, repo policy, and specs may define lenses and applicability but never
another review protocol or retry loop.

`$tickets-orchestrator` is an outer delivery caller. Each ticket selects
`direct`, `compact spec`, or `standard spec`. Direct tickets keep the `$tdd` and
repo-review flow without manufacturing Implementation Review State. For each
compact/standard ticket, root invokes `$implementation-spec-maker` and then
`$spec-implementer`; the orchestrator must not reproduce either review Module
or combine approved tickets into a wave-level implementation spec.

## External Research Preflight

Read local evidence before searching externally. Keep one narrow documentation
lookup inline with the owning specialized docs skill or tool unless the user
explicitly requests delegation or a durable artifact. Invoke `$research` for
either explicit request, or when a material coding decision requires
multi-source comparison, freshness checking, or external contract synthesis.

`$research` authorizes one `researcher_standard` child. Root supplies a bounded
Research Capsule, verifies every claim that drives architecture, scope,
implementation, security, cost, or compatibility, and saves one artifact under
the repository convention or `docs/research/YYYY-MM-DD/HHMM-<slug>.md`.
Research is evidence, not implementation authority. Downstream plans, PRDs,
tickets, and specs cite the artifact; behavior-changing work still follows the
normal TDD, implementation, and review routes.

## Precedence

1. If the user asks not to edit code, use diagnosis or review skills and stop before implementation.
2. If the user asks to fix, implement, or build, apply `$tdd` before planning or editing.
3. If a bug is hard, flaky, or performance-related, use `$diagnosing-bugs` to build a feedback loop before fixing.
4. If a fix path has already been approved, use `$code-debugger` to implement and verify it.
5. Run one final `$code-review` wave with bounded cleanup in its spec/standards lens. High-risk work uses two disjoint reviewers in parallel. Run separate `$cleanup-review` only for an explicit concrete evidenced reason that cannot fit that lens; size or risk alone is insufficient.

Reviewer repairs inside an active authorized implementation/TDD flow follow
[`bug-workflow-routing.md`](bug-workflow-routing.md) and do not automatically
start `code-debugger`; standalone or ambiguous fixes retain the normal route.

## Local Fact Rule

When a global skill needs a repo fact, it should read local evidence first: `AGENTS.md`, `CONTEXT.md`, ADRs, package manifests, lockfiles, existing tests, scripts, and local skill docs. If the fact is not present, say it is not confirmed instead of inventing it.

## Availability, Depth, And Fallback

- Request the exact role name and always start it without inherited conversation; put the necessary verified context in a self-contained brief because full-history forks can inherit the parent profile.
- `agents.max_depth = 1`: children never spawn grandchildren. Root directly owns mandatory reviewer and worker launches.
- After collecting a child's result, root must close it in a finally-equivalent path. Parallel launch must preserve every fulfilled handle (use `allSettled` or equivalent), then close partial launches after timeout, cancellation, or error so completed agents do not consume `max_threads` slots.
- If a required reviewer role is unavailable, do not silently substitute a generic child, inherit root settings, or self-review inline. Report the gate as unavailable or blocked. Non-review skills may keep their explicit inline fallback rules.
- Never override a named role's model or effort at spawn time. Change and revalidate the role file instead.

## Broad Exploration Delegation

Route discovery by required output:

| Need | Route |
| --- | --- |
| Known path or one narrow execution path | Root reads inline |
| Mechanical inventory or large diff/log scan | `explorer_quick` |
| Bounded cross-module execution trace | `explorer_fast` |
| Material external docs/API/spec question | `$research` with `researcher_standard` |
| Ambiguous architecture, root cause, or contract synthesis | `analyst_deep` |

Give each child one **Discovery Capsule**: question, known entrypoint, scope,
excluded areas, and expected `answer -> execution path -> file:symbol evidence ->
uncertainty`. Stop when the question is answered or missing evidence is proven.
Use at most two explorer children, only for disjoint questions, and reuse the
same child for follow-up instead of restarting discovery.

Root verifies evidence that drives edits and keeps a compact **Evidence Map**
for reuse by plan, spec, and implementation. Re-read only entries invalidated by
changed files, contracts, or external sources. `analyst_deep` remains a final
synthesis escalation, not a substitute for evidence collection.

## Contract Test Ledger Rule

Use [`contract-test-ledger.md`](contract-test-ledger.md) for behavior-changing
tasks with contract risk. It maps each invariant to the first failing test or
observable proof before implementation.

## Progressive Disclosure Rule

Keep main skill files focused on routing, workflow, safety, and output. Load
long checklists, framework lenses, recipes, examples, and rubrics from references
only when their trigger applies.
