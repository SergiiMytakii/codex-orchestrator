# Coding Skill Routing

This file is the normative global coding route. Repository commands, product
facts, runtime constraints, and domain language remain in repository policy.

## Shared Kernel

- **Authority** — perform only the requested outcome and actions authorized by
  the user, Parent PRD, executable ticket, and repository policy. Planning or
  publication never authorizes implementation. Normal direct and single-ticket
  Implement authority includes one scoped local commit after proof and
  applicable Review unless user or repository policy explicitly forbids or
  reserves Git. Push and PR require separate authority.
- **Preservation** — preserve unrelated and concurrent work plus user-owned
  runtimes. Dirty overlapping or unisolatable scope blocks the affected write
  and commit.
- **Proof** — claim only the observable outcome proved through the real caller
  seam. Missing required proof or independent-review approval blocks completion
  and the affected commit.

These principles are checks, not workflow state or durable artifacts.

## Main Route

The user-facing coding flow is Plan, Implement, Review.

- [`$plan`](../../skills/plan/SKILL.md) owns product decisions and multi-ticket
  planning composition. It is the sole planning-composition entrypoint.
- [`$implement`](../../skills/implement/SKILL.md) is the single execution owner
  for clear features, fixes, obvious local edits, and executable tickets.
- [`$code-review`](../../skills/code-review/SKILL.md) is the direct Review
  entrypoint.

Direct non-ticket work stays in the current root context. Do not create a spec,
ticket, or worker merely because a change spans files or touches an important
contract. A real product or ownership decision gap returns to Plan. An approved
multi-ticket dependency graph routes to `$tickets-orchestrator`; a single
executable ticket never does.

Diagnosis-only work uses `$bug-root-cause-explainer`. Hard, flaky, unclear, or
performance bugs use `$diagnosing-bugs` to establish a reliable signal, then
return to Implement when a fix is authorized. External multi-source uncertainty
uses `$research`. A requested throwaway logic or UI experiment uses `$prototype`
to answer one bounded design question, then returns production delivery to
Implement. Grilling, TDD, to-spec, to-tickets, diagnosis, research, prototype,
and the graph-only Tickets Orchestrator are internal or side primitives.
Specialized runtime and platform skills remain side tools and do not compete
with the main flow.

## Implement Context

- A direct request is implemented by root in the current context.
- One executable ticket launches exactly one fresh `implementer` child. Root
  supplies the complete ticket, Parent PRD, applicable repository policy, and
  bounded write scope; verifies the child identity and completed wait; and
  remains the only Git owner.
- Multiple executable tickets are graph work and remain owned by
  `$tickets-orchestrator`.

Children do not talk to the user, spawn grandchildren, or perform Git actions.
Root integrates only isolated worker output and never overwrites unrelated work.

## TDD, Proof, And Review

Use [`$tdd`](../../skills/tdd/SKILL.md) where possible: an observable behavior
change has a natural public seam and a meaningful failing signal can precede
the implementation. Otherwise use direct proof. Do not manufacture tests for
docs, copy, formatting, mechanical config, deletion, or an outcome that cannot
fail meaningfully before the edit.

A change is substantial when its behavior or contract goes beyond an obvious
local edit. This includes a public API, persistence, auth or payment,
concurrency or shared state, and cross-module interaction. Substantial settled
work launches one fresh `standards_reviewer`. It checks the result against the
request, issue, or Parent PRD and checks correctness, repository rules, cleanup,
and legacy or duplicate ownership.

The wait must complete and the reviewer must approve the settled diff.
Docs, copy, formatting, mechanical config, and an obvious local correction may
finish with direct proof and no reviewer. Reviewer failure or timeout blocks
approval; root does not replace independent review with self-review.

A Review blocker requires a concrete correctness defect, missing obligation,
required-proof gap, or real ownership or runtime conflict. A Fowler smell,
general improvement, preference, or uncertain concern is a non-blocking
observation unless separate evidence proves one of those concrete impacts.
Review remains read-only and runs one fresh Standards reviewer per invocation.

For direct or single-ticket substantial work, Implement consolidates all
blockers from each review into one repair batch for that revision. The original
Implement authority covers every verified in-scope repair without another user
confirmation. After repair it reruns affected proof and launches a targeted
fresh reviewer over only the repair delta, repaired blockers, direct impact cone,
and affected proof. Untouched previously approved scope retains approval. This
repair and targeted Review loop continues until approval; reviewer count is not a
stop condition. A complete Review repeats only when repair impact cannot be
isolated from previously approved scope.

Graph children receive no per-ticket delivery Review. After every checkpoint,
Tickets Orchestrator owns the initial cumulative review over the complete Parent
range, then follows the same unlimited repair loop with targeted Review of each
repair delta and directly affected Parent obligations.

Proof and applicable review must approve before staging or commit. Direct and
single-ticket Implement creates one scoped local commit by default when the
worktree is isolatable. Explicit user or repository policy that forbids or
reserves Git overrides that default. Push and PR always require separate
authority.

## Stable Roles

Skills request only these stable roles; concrete model and reasoning effort are
central configuration details:

| Need | Role |
| --- | --- |
| Root dialogue, integration, and Git ownership | `root` |
| One isolated executable ticket | `implementer` |
| Requirement fidelity, correctness, and repository-standards review | `standards_reviewer` |
| Bounded repository exploration | `explorer` |
| Independent bounded design alternative | `explorer` |
| Primary-source external research | `researcher` |

## Runtime Safety

For Flutter UI, follow [`tool-usage.md`](tool-usage.md). Treat live app, IDE, VM
Service, and `flutter run` sessions as user-owned. Use the documented
non-destructive attach path only after ownership discovery; never replace or
terminate a user-owned session without explicit authority.
