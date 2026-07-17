---
name: "implementation-spec-maker"
description: "Compiles an approved plan, implementation ticket, discovery task, or existing spec revision into a deterministic implementation spec for a downstream coding agent. Defaults to a compact execution checklist and expands to a full contract only when compact mode cannot express concrete coordination, contract, ownership, sequencing, or validation ambiguity safely. Reviews the draft through the convergence-driven risk-aware Artifact Review Loop before saving."
---

# Implementation Spec Maker

Create or revise an execution-ready implementation spec for a downstream coding agent. The spec is not product discussion and does not implement code. It must remove guesswork around scope, paths, commands, contracts, fixtures, validation, and handoff.

For behavior-changing specs with contract risk, use the shared Contract Test Ledger reference: `../../docs/agents/contract-test-ledger.md`.

## Accepted Inputs

- **Plan-based:** an approved plan, usually from `plans-maker`.
- **Issue-based:** one implementation issue, with parent PRD/issue when available.
- **Contract/discovery:** an issue that must confirm an external contract before implementation.
- **Revision-based:** an existing implementation spec plus new source material.

## Operating Gates

### 1. Source Authority Gate

- Treat the provided plan, ticket, discovery task, or existing spec as the source of scope.
- Preserve approved scope, out-of-scope items, protected paths, rejected approaches, blocker decisions, validation gates, and required docs.
- Fail closed: if source material, repo evidence, or external contracts are insufficient, ask targeted questions or save a `blocked` spec.
- Do not invent exact paths, symbols, commands, fixtures, env vars, ownership, schemas, or API contracts. Confirm them from code, docs, issues, comments, or trusted external sources.

### 2. Evidence Gate

- Inspect only the repo evidence needed for deterministic execution: files, symbols, commands, fixtures, env vars, consumers, routes, schemas, jobs, UI surfaces, and generated artifacts.
- Prefer local evidence. Use external docs only when an external contract or current package/API detail is genuinely required.
- Keep evidence close to the work it protects; avoid broad file inventories.
- Reuse the plan's Evidence Map and any cited `$research` artifact. Re-read only entries invalidated by changed files, versions, dates, contracts, or source conflicts; invoke `$research` when a material external contract still lacks durable evidence.

### 3. Mode Gate

Classify three independent dimensions before drafting:

- `spec_mode`: document density and coordination detail, `compact | full`
- `implementation_size`: expected delivery shape, `small | medium | large`
- `review_profile`: consequence and uncertainty, `simple | medium | high`

Also record `expected_repositories` as the exact positive integer known from the
approved scope. These fields must not stand in for one another.

Default to **compact mode** for single-agent work when exact scope, risk controls,
and proof fit clearly. Compact describes a dense execution contract, not a small
implementation. A coherent cross-repo or high-risk outcome may remain compact
when ownership, sequencing, and proof are deterministic; several independently
releasable workflows or unresolved coordination boundaries require full mode.

Review profile does not select spec mode. A high-risk review profile may still
use compact mode when the risky invariant, proof, and stop condition fit there
without ambiguity.

For ticket work, `direct` returns to `$tdd`, `compact spec` requests compact
mode, and `standard spec` requests full mode. Correct the request only with
repository evidence, without changing product scope.

Use **full mode** only when compact mode would leave meaningful safety, contract, ownership, sequencing, or validation ambiguity. These are escalation signals, not automatic reasons to write a long spec:

- multi-agent execution
- persistence, migrations, schemas, DTOs, API contracts, or external contracts that need exact cross-file contracts before coding
- auth, permissions, payments, caching, concurrency, background jobs, shared state, or destructive operations where a wrong implementation can corrupt data, leak access, or change production behavior
- changes across several runtime surfaces where ownership or validation cannot be expressed compactly
- one ticket whose multi-agent execution needs explicit ownership, merge order, or final validation
- revision of an existing spec with completed checklist history
- useful blocked artifact for unresolved ambiguity

Full mode is still lean. Add only the controls required by the ticket's risk.
Use it only when a compact draft cannot express a concrete ambiguity safely,
not merely because one escalation signal exists.

### 4. Review Gate

Run `implementation-spec-review` through
`../../docs/agents/artifact-review-loop.md` before saving any reviewable spec.
A useful preflight-blocked spec may be saved with zero reviews, the Module
outcome `Blocked`, and the exact blocking unknown; do not fabricate a reviewer
verdict. An explicit user waiver is saved as Module outcome `Waived`, never as
review approval.

- Invoke the artifact Module as the caller-facing review owner and do not reproduce its internal review mechanics. Record `review_profile` and evidence-backed `review_reasons` independently from spec size.
- Invocation of `$implementation-spec-maker` authorizes the Module's profile-selected reviewer topology with `$implementation-spec-review` as its Adapter; root must not replace it with inline self-review.
- Supply the current spec, source authority, approved decisions, and repo evidence. Root owns defect aggregation and consolidated spec repairs between Module waves.
- Fix every locally resolvable blocker and execution risk. If review exposes a product, contract, source-of-truth, ownership, or validation decision that cannot be resolved locally, ask the user or preserve it in the Module outcome.
- Conserve source scope when applying review repairs. Optional improvements remain excluded unless the source authority or user explicitly approves them.
- Record the Module outcome, last real Adapter verdict or `Not run`, review counts, and open stable IDs. Never use `review_verdict: "Not required"`.

### 5. Execution Shape Gate

- Use numbered phases, but each implementation phase must be a vertical tracer-bullet slice, not a horizontal layer pass.
- A slice must deliver one narrow, verifiable behavior through every required layer end-to-end.
- For behavior-changing code, each slice must name the first behavior test or observable proof before implementation actions.
- For UI, visual, layout, responsive, screenshot/video, frontend, or app-facing behavior changes, the slice's Test/Proof First entry must include a concrete `$ui-evidence-proof` checklist: exact workflow, expected screen state, relevant viewport coverage, fresh artifact expectation, layout review targets, copy review targets, and criterion-to-artifact mapping. Do not accept "take a screenshot" as sufficient proof.
- For contract-heavy behavior changes, include a compact Contract Test Ledger that maps each material invariant affecting approved behavior or design to the first RED test/proof before implementation. Do not enumerate every conceivable edge case.
- For high-risk changes involving state transitions, queues, retries, idempotency, persistence, auth, payments, caching, background jobs, or shared state, add an early review checkpoint only when the first risky slice becomes stable before later work and later slices will not modify its files, owners, or contracts. Otherwise assign those lenses to the final parallel review wave; do not manufacture a review over an unstable slice.
- For each high-risk review checkpoint, add a short `Review Focus` that names the mandatory lenses and concrete bug classes the reviewer must hunt, such as duplicate side effects, retry/idempotency, ordering, source-of-truth ownership, partial failure, DTO/schema drift, or false user-facing state.
- For medium/high-risk specs, include `Final Handoff Requirements` so the executor's final chat response answers the user's approval questions without requiring a manual diff audit: contract implemented, high-risk checkpoints, invariants proved, review findings/fixes, validation, skipped checks, residual risks, and files by role.
- Prefer RED -> GREEN -> refactor per slice. Do not batch all tests first and do not defer all tests to a final phase.
- If automated testing is not applicable, state the exact manual/live proof inside that slice.
- Discovery, contract-confirmation, and final reconciliation phases are allowed when needed, but must not hide implementation work.

### 6. Ownership And Safety Gate

- Keep `execution_model: "single-agent"` unless write scopes are perfectly disjoint and an integrator contract is necessary.
- Never let two agents edit the same file, generated artifact, source-of-truth rule, schema, migration, or shared contract concurrently.
- Name one source of truth for behavior/data ownership. Label transport, projections, caches, and compatibility layers as non-owners.
- Reuse existing owners/helpers where appropriate. Add helpers/services/layers only when the spec states why the direct path is insufficient now.
- Apply `$codebase-design` principles only when ownership or a public seam changes, without turning the spec into an architecture essay: prefer deep Modules, small Interfaces, clear Seams, Leverage, and Locality.
- Require a deletion-test note for any new Module, helper, layer, or Seam added by the spec. If it is a pass-through, remove it from the spec.
- Do not introduce a new Adapter abstraction for a one-adapter Seam unless the source material gives a current, concrete reason.
- For behavior changes, make the Module Interface the test surface. Do not specify tests that reach into Implementation details unless no public seam exists and the spec records that testing gap.
- Do not add stealth cleanup, compatibility shims, migrations, abstractions, or future-facing branches outside approved scope.
- Do not add feature flags, telemetry systems, dashboards, rollout machinery, compatibility paths, or generic fallbacks unless the source requires them or a concrete evidenced failure path makes them necessary.
- Require comments/docblocks only for exact non-obvious public APIs, exported contracts, or complex logic sites.

## Source Modes

### Plan-Based

- Treat the plan as architectural authority.
- Preserve approved scope, vertical-slice boundaries, guardrails, rejected paths, required docs, validation gates, and blocking assumptions.
- Block if the plan lacks enough guardrails to protect execution scope.

### Issue-Based

- Treat issue acceptance criteria as the execution contract.
- Treat parent PRD/issue content as product scope, not permission to implement unrelated child work.
- Read comments for decisions, changed contracts, blockers, credentials, live prerequisites, and rejected approaches.
- Preserve issue sections such as `Implementation preparation`, `External contracts`, `Verification`, and `Blocked by`.
- Keep the spec scoped to this ticket. A parent PRD supplies product authority, not permission to absorb sibling tickets.
- If no plan exists, use `source_type: "issue"`; do not block only because `source_plan` is absent.
- Block if acceptance criteria are ambiguous, non-verifiable, or contradicted by repo reality.

### Contract/Discovery

- Specify discovery only: exact docs/pages/tools to inspect, proof to collect, decision record to update, and issue fields/comments to update.
- Confirm API surface, auth/secret source, license/terms constraints, acquisition/download path, deterministic fixture strategy, live validation prerequisite, and rejected acquisition paths.
- Do not include downstream implementation phases until the contract is confirmed.
- Block if implementation still depends on unconfirmed external behavior.

### Revision

- Re-check the whole spec for stale instructions and contradictions.
- Preserve still-valid completed `[x]` items exactly.
- Reopen invalid completed items to `[ ]` and add `Revision Note:` with the reason.
- Do not silently delete progress history.
- If the old ledger cannot be trusted, mark the spec `blocked` until reconciled.

## Workflow

1. Absorb source material: source plan/issues/comments/spec, repo policy, accepted scope, blockers, guardrails, external contracts, prerequisites, validation, and delivery expectations.
2. Inspect repo evidence: confirm only the exact paths, symbols, commands, fixtures, env vars, contracts, consumers, and surfaces needed.
3. Choose compact or full mode and single-agent or multi-agent execution. When in doubt, draft compact first and expand only the missing risk controls.
4. Draft the spec from the relevant template below.
5. Convert horizontal source phases into vertical slices unless that changes approved scope or dependencies; block if conversion is unsafe.
6. Put the behavior-first test/proof at the start of every behavior-changing slice, and add a Contract Test Ledger for contract-heavy slices.
7. Run the risk-aware Artifact Review Loop with the `$implementation-spec-review` Adapter and collect its stable Defect Ledger.
8. Apply consolidated feedback through the Artifact Review Module until it returns a terminal outcome.
9. Save only the final reviewed spec to `docs/implementation-specs/YYYY-MM-DD/HHMM-<slug>.md`.
10. Respond with exactly the fields from Final Action.

## Compact Spec Template

Use for single-agent specs whose exact scope, risk controls, and proof fit compactly, including narrow high-risk specs. Remove placeholders before saving. If a value cannot be confirmed, set `status: "blocked"` and explain it in `Blocking Unknowns`.

```markdown
---
title: "<spec title>"
created_at: "<ISO timestamp>"
source_type: "plan | issue | contract-discovery | revised-spec"
source_plan: "<absolute path to source plan, or None>"
source_issues:
  - "<issue URL/reference, or None>"
status: "ready | blocked"
execution_model: "single-agent"
spec_mode: "compact"
implementation_size: "small | medium | large"
expected_repositories: <positive integer>
review_profile: "simple | medium | high"
review_reasons:
  - "<risk signal: source or repo evidence>"
review_outcome: "Approved | Blocked | Waived"
review_verdict: "Approved | Needs Work | Rejected | Not run"
review_coverage: "<mandatory lenses covered | Not reviewed>"
---

## 1. Execution Context
- **Goal:** <one sentence>
- **Source Material:** <exact plan path, issue URLs, parent PRD/issue, or existing spec path>
- **Approved Scope:** <strict allowed work>
- **Out of Scope:** <explicit exclusions or None>
- **Simplest Viable Path:** <direct implementation path>
- **Primary Risk:** <main correctness or coordination risk>

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** <exact values or None>
- **Blocking Unknowns:** <only when status = blocked; otherwise None>
- **Confirmed Targets:** <minimal evidence-backed files/symbols>
- **Confirmed Commands:** <exact repo commands>
- **Protected Paths / Rejected Approaches:** <exact items or None>
- **Ownership / New Boundaries:** <only when an owner or seam changes; include deletion-test result for additions, otherwise omit>
- **Contract Test Ledger:** <required for contract-heavy behavior changes; otherwise Not applicable>

## 3. Execution Slices

### Progress Discipline
- [ ] Update this checklist as work is completed.
- [ ] Leave blocked work unchecked with a short `Blocked:` note.
- [ ] Stop if repo reality contradicts a confirmed target, command, precondition, or scope boundary.
- [ ] Keep each implementation phase as a vertical tracer-bullet slice, not a horizontal layer pass.
- [ ] For behavior changes, start each slice with a behavior-first test/proof before implementation work.
- [ ] For contract-heavy changes, update the Contract Test Ledger status as each invariant moves planned -> red -> green or blocked.
- [ ] For high-risk specs, run only stable required Review Checkpoints; move unstable checkpoint lenses to the final parallel review wave.

### Slice 1 - <Tracer Slice Name>
- [ ] Objective: <narrow end-to-end behavior this slice makes verifiable>
- [ ] Test/Proof First: <exact failing behavior test to write/run first, or exact manual/live proof if automated testing is not applicable; for UI changes include exact workflow, viewport, layout/copy checks, fresh artifacts, and criterion-to-artifact mapping>
- [ ] Target: `<exact/path>`
  - [ ] Action: <exact edit>
  - [ ] Validation: <exact check proving this target>

### Slice Exit Gate
- [ ] <exact command/check or observable proof that this slice works end-to-end after RED -> GREEN>

### Review Checkpoints
- [ ] <high-risk only when the risky slice becomes stable before later work; otherwise state that the named lenses move to final parallel review>

### Review Focus
- <required only for high-risk specs; mandatory `$code-review` lenses, targeted recipes, and concrete risks to inspect>

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** <exact command or Not applicable>
- [ ] **Typecheck:** <exact command or Not applicable>
- [ ] **Tests:** <exact command or Not applicable>
- [ ] **Architecture Check:** <exact command or Not applicable>
- [ ] **Live/Manual Validation:** <exact flow or Not applicable>
- [ ] **Behavior Proof:** <observable proof for changed behavior>
- [ ] **Final Reconciliation:** all unchecked work is unfinished, blocked with a note, or intentionally not applicable.
- [ ] **Final Handoff Requirements:** <required for medium/high-risk specs; final response must include Contract implemented, High-risk checkpoints, Main invariants proved, Code-review findings, Fixes after review, Validation, Skipped checks, Residual risks, and Files by role>

## 5. Final Action
After saving the file, respond in chat with exactly:

Spec Status: Ready / Blocked
Saved Path: docs/implementation-specs/...
Execution Model: Single-Agent / Multi-Agent
Implementation Size: Small / Medium / Large
Expected Repositories: <n>
Review Outcome: <Approved | Blocked | Waived>
Adapter Verdict: <Approved | Needs Work | Rejected | Not run>
Review Profile: <simple | medium | high>
Review Passes: <n total; full/closure/fresh counts>
Mandatory Coverage: <covered lenses or gaps>
Verified Defects: <stable IDs or None>
Accepted Risks: <stable IDs, authority, and reason or None>
Open Defects: <stable IDs or None>
Validation Gates: Local / Live / Tests
Blockers: <unresolved blockers or None>
```

## Full Spec Additions

Start from the compact template. Set `spec_mode: "full"`. Add only the sections needed for the actual risk.

### Risk Controls

```markdown
## Risk Controls
- **Source of Truth:** <exact owner for state/rule/contract that can drift, or Not applicable>
- **Safety Constraints:** <secret/destructive/protected-production constraints, or Not applicable>
- **Contract Constraints:** <API/DTO/schema/external contract constraints, or Not applicable>
- **Concurrency / State Constraints:** <idempotency/retry/transition constraints, or Not applicable>
- **Forbidden Scope:** <specific tempting but rejected implementation paths, or Not applicable>
- **Early Review Gate:** <high-risk only when the first risky slice becomes stable before later work; otherwise Not applicable, with named lenses assigned to final parallel review>
- **Final Handoff Requirements:** <required for medium/high-risk specs; exact proof summary the executor must return in chat and whether a separate report file is required>
```

Use this table only when multiple behaviors have different owners/readers:

```markdown
| Behavior / Data | Owner | Readers / Projections | Non-Owners |
|-----------------|-------|-----------------------|------------|
| `<behavior>` | `<owner>` | `<readers>` | `<non-owners>` |
```

### Write Scope Summary

Required for multi-agent specs, broad runtime changes, generated artifacts, or 5+ expected runtime files. Optional otherwise.

```markdown
## Write Scope Summary
- `<exact/path>` - <Create/Update/Delete>; <responsibility>; reuse <target or None>; docs <target or None>
```

### Integrator Coordination Contract

Required only when `execution_model = "multi-agent"`.

```markdown
## Integrator Coordination Contract
| Agent | Exclusive Write Scope | Handoff Artifact | Merge Phase | Notes |
|-------|-----------------------|------------------|-------------|-------|
| `<agent>` | `<exact files/modules>` | `<artifact>` | `<phase>` | `<notes>` |

- **Integrator Owner:** <exact owner>
- **Forbidden Overlap:** <exact files/artifacts>
- **Merge Order:** <exact order>
- **Integrator Final Duties:** <exact duties>
```

### Halt Conditions

Use only when risk needs explicit stop rules. Add 3-6 task-specific conditions, not a generic checklist.

```markdown
## Halt Conditions
- [ ] <task-specific mismatch or missing precondition that must stop execution>
- [ ] <task-specific ownership/contract/safety violation that must stop execution>
- [ ] <task-specific validation or live-contract failure that must stop execution>
```

### Defect Closure Notes

Required when `implementation-spec-review` returns defects. Omit only when the final review has no defects.

```markdown
## Defect Closure Notes
- **Review Summary:** <total review passes, full/closure counts, fresh sessions>
- [ ] Every stable Defect Ledger ID is `verified`, `blocked` with a concrete reason, or an explicitly accepted execution risk.
- **Open Defects:** <stable IDs or None>
```

## Post-Implementation Signoff Requirement

For medium changes, preserve this executor order:

1. Implement the approved scope.
2. Update the spec checklist during implementation.
3. Reconcile all unchecked items.
4. Run validation commands.
5. Run the repo architecture check when applicable.
6. Run one final `$code-review` with bounded cleanup in its spec/standards lens.
7. Integrate safe fixes and rerun relevant validation.
8. Prepare the final user-facing completion message.

For high-risk changes, run two disjoint `$code-review` tracks in one parallel
final wave; the spec/standards track includes bounded cleanup. Insert separate
root-owned `$cleanup-review` only when the user, approved source, or repo policy
names a concrete evidenced reason that cannot fit that bounded lens. Size or
risk classification alone is insufficient.
