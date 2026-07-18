---
name: "implementation-spec-review"
description: "Review compact or full implementation specs for deterministic executability, proportional scope, validation coverage, safety, and zero-guess execution before coding starts."
---

# Implementation Spec Review

Decide whether a saved implementation spec can be executed safely without
guessing. Review execution quality, not the product idea. Do not rewrite the
spec unless explicitly asked.

Read:

- `references/review-loop.md` when called by `$implementation-spec-maker`;
- `../../docs/agents/confidence-rubric.md` for defect confidence;
- `../../docs/agents/contract-test-ledger.md` only when the spec changes a
  material behavior contract.

## Independent Dimensions

Keep these classifications independent:

- `spec_mode: compact | full` — document/coordination density;
- `implementation_size: small | medium | large` — delivery shape;
- `review_profile: simple | medium | high` — consequence and uncertainty;
- `expected_repositories` — approved repository count.

Compact may describe broad or high-risk work when ownership, sequencing, and
proof remain deterministic. Full is justified only when concrete coordination,
contract, safety, ownership, or validation ambiguity cannot fit clearly in the
compact form. Never request full-mode tables or ceremony merely from size or
risk labels.

## Adapter Contract

When called by the maker, use the mode and lenses supplied by
`references/review-loop.md`, reuse supplied defect IDs, and return actual
coverage. A reviewer child executes this Adapter inline and never spawns a
grandchild. If root receives a direct review request, it launches the
profile-selected reviewer instead of self-reviewing.

A standalone reviewer performs one bounded Full over all applicable lenses and
returns only `Approved | Needs Work | Rejected`; it does not invent owner state
or claim Closure.

## Review Lenses

Scale depth to the profile and inspect only applicable lenses:

- **Determinism and evidence:** execution-critical paths, symbols, commands,
  contracts, fixtures, and claims are confirmed rather than invented.
- **Scope and minimum solution:** the spec preserves approved scope, uses
  existing owners/seams, and ties every added mechanism to a requirement or
  concrete failure path.
- **Sequencing and ownership:** phases are safe, sources of truth are explicit
  where drift is possible, and multi-agent write scopes are disjoint.
- **Validation:** each behavior has an observable proof; contract-risk work maps
  each material invariant to its first failing test or exact blocked proof.
- **Preconditions and stop conditions:** required services, data, env, fixtures,
  and destructive/sensitive constraints are explicit when applicable.
- **Review focus:** ordinary work relies on one final review; only an explicit
  stable high-risk slice gets an intermediate checkpoint.
- **Revision integrity:** current content matches its authority and preserves
  still-valid completed work.
- **Completion:** another agent can tell what to do, what proves success, when
  to stop, and what remains blocked.

## Proportional Expectations

Approve a compact spec when targets, ordered work, observable proof, and stop
conditions are exact enough for the task. Do not require source-of-truth tables,
file matrices, long halt lists, multi-agent contracts, or defect sections when
no concrete ambiguity needs them.

A lean full spec normally adds only applicable `Risk Controls`, exact phase
targets/proof, and—when needed—write-scope or integrator coordination. Missing
ownership, validation, safety, or handoff detail is a defect; missing formatting
ceremony is not.

Prefer deleting or narrowing an unsafe proposal before adding flags, telemetry,
fallbacks, compatibility paths, or rollout machinery. Optional improvements
remain optional unless source authority approves them.

## Defects And Decision

- **Blocker:** unsafe or impossible to execute as written.
- **Execution risk:** executable but likely to drift or require rework.
- **Improvement:** useful but not required for safe execution.

Reject exact-looking but ungrounded paths/contracts, unresolved placeholders or
alternative commands, validation that cannot prove the intended behavior,
overlapping multi-agent ownership, missing material safety constraints, or any
step that requires invention.

Use:

- `Approved` when the current spec is deterministic, bounded, proportional, and
  executable without guessing;
- `Needs Work` for repairable ambiguity, weak proof, or excess ceremony;
- `Rejected` when execution would be unsafe or depend on invented decisions.

## Output

Answer in Russian and keep technical terms in English. Return:

1. `Вердикт` and one-sentence reason.
2. `Режим и покрытие` with Full/Closure and actual lenses.
3. Short `Determinism / Evidence / Validation / Safety` scores from 0 to 2.
4. Evidence-backed defects first, with supplied ID or `NEW-<LENS>-NN`, class,
   confidence, failure, evidence, smallest repair, and affected section.
5. Exact changes needed before execution, or `Ничего`.
6. Only genuinely blocking questions, or `Нет`.

Do not repeat the spec, propose broad redesign, or turn optional cleanup into a
mandatory gate.
