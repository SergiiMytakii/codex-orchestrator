---
name: "spec-implementer"
description: "Executes approved specs phase by phase with checklist updates, validation gates, risk-based commit checkpoints, and required review/signoff."
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

# Spec Implementer

Execute an approved implementation spec. Your job is to carry out the chosen spec, keep its checklist honest, and stop at the right boundaries. Do not redesign the work unless the spec or repo reality proves a blocker.

This skill is standalone by default: it executes only an approved spec that the
user has chosen to run. ``tickets-orchestrator`` may invoke it inline at root for
an accepted issue-level or wave-level spec inside user-authorized orchestration;
that does not authorize unrelated specs or broader delivery scope.

When a spec contains a Contract Test Ledger, treat it as part of the execution contract. The shared reference is `../../shared/docs/agents/contract-test-ledger.md`.

All implementation review checkpoints and final review gates use
`../../shared/docs/agents/implementation-review-loop.md`. That Module owns the
whole-spec review budget, Full/Closure modes, reserved final coverage, and stop
rules. This skill must not reset review allowance per slice or create an
independent retry loop.

## Spec Modes

- **Compact specs:** execute directly with lightweight phase checkpoints. Use review/signoff gates only when the spec, repo policy, or change risk requires them.
- **Full specs:** execute the same phase flow, but treat `Risk Controls`, task-specific `Halt Conditions`, and validation proof as hard constraints. Do not invent extra process just because the spec is full.
- **multi-node specs:** follow the integrator contract exactly. If write scopes are not perfectly disjoint, stop before route workers.

## Core Rules

1. Follow the spec literally. Do not broaden scope, add cleanup, or re-plan unless a blocker is proven.
2. Treat the spec checklist as the execution ledger.
3. Update checklist items during implementation. For compact specs, update at natural checkpoints and phase exits. For full specs, or when the spec says so, update completed leaf items immediately.
4. Do not save all checklist updates only for the final response.
5. Re-read the current phase before moving on and reconcile already-completed unchecked items.
6. If a step is blocked, leave it unchecked and record one short `Blocked:` note with the concrete reason.
7. Treat Preconditions as hard blockers. Do not start a phase until they are satisfied, explicitly not applicable, or blocked.
8. If the saved spec contains unresolved template text, placeholders, alternative commands, or pseudo-paths, stop and escalate.
9. Honor Protected Paths and Rejected Approaches exactly as written.
10. Apply the ``improve-codebase-architecture`` lens locally: before adding a new module/helper/adapter/seam, run the deletion test and keep it only if it improves locality or leverage for the current task.
11. Do not add pass-through modules, one-adapter seams, or test-only helpers unless the spec explicitly approves them.
12. Add comments/docblocks only where the spec explicitly requires them.

## Before Editing

- Confirm the spec path and status.
- Identify whether it is compact, full, or multi-node.
- Check required services, env vars, fixtures, repo state, and prerequisite issues.
- Confirm the first phase targets exist as described.
- Confirm validation commands are executable or explicitly not applicable.
- If the spec has a Contract Test Ledger, confirm each reached invariant has a first test/proof or a concrete blocked reason before implementation.
- If the spec has `Review Checkpoints` or `Review Focus`, translate them into hard execution gates before editing. Stop if a high-risk spec should have an early review checkpoint but the spec omits it.
- Resolve the implementation review profile, create the Module's Review Plan,
  and reserve mandatory final slots before launching any checkpoint reviewer.
- Persist that plan and its counters under `## Implementation Review State` in
  the spec before the first launch, then update it after every usable reviewer
  result, repair batch, closure, waiver, or terminal outcome.
- If the spec has `Final Handoff Requirements`, treat them as the final response contract. For medium/high-risk specs without explicit requirements, prepare the standard Final Risk Handoff anyway.
- For full specs, read `Risk Controls` before editing and translate each applicable control into a concrete execution constraint.
- Use `Write Scope Summary` when present as an audit aid. If it is absent, rely on phase targets unless the write set is ambiguous.
- Stop if exact execution would require guessing.

## Git Checkpoints

Before editing, announce `none` or `per-slice`. User instructions, the spec, and repo policy override this choice. Invoking ``spec-implementer`` authorizes commits when `per-slice` is selected.

Choose `per-slice` only when slice diffs can be isolated and checkpoints materially improve recovery, review, or handoff safety. Strong signals are:

- three or more independently verifiable implementation slices
- a medium/high-risk slice with substantial implementation remaining
- a full or multi-node spec with integration, handoff, or rollback boundaries
- a user pause or likely continuation in another session

Choose `none` for compact low-risk specs with one or two implementation slices, non-implementation phases, or known overlapping changes that prevent safe isolation. Do not decide from file count alone.

At each checkpoint:

- require a passed exit gate and applicable slice review, then reconcile and include tracked checklist/ledger updates
- inspect the full diff, stage only slice-owned paths or hunks, follow ``commit`` safety rules, and verify the hash
- treat the applicable slice review as the pre-commit gate; final review still runs at the end

If isolation later becomes unsafe, skip and record the reason. Never commit RED state, failed validation, unresolved findings, discovery-only work, or a partial slice. Never amend a checkpoint commit; put later fixes in a new commit. Never push unless explicitly requested. Report the strategy and slice-to-commit mapping, or the reason no checkpoints were created.

## Phase Workflow

For every phase:

- Confirm phase dependencies and preconditions.
- Execute only the steps assigned to that phase.
- Update the spec checklist according to its mode.
- Update any reached Contract Test Ledger rows as planned -> red -> green, or blocked with the missing seam/proof.
- Run the phase exit gate.
- If a `Review Checkpoint` applies after this phase, execute it through the
  Module with the exact checkpoint target and specified `Review Focus`. Continue
  only when the Module outcome permits it; do not reinterpret an incompatible
  checkpoint inside this caller.
- Reconcile unchecked items for the current phase.
- Re-check applicable `Risk Controls` before leaving the phase.
- Check whether the phase introduced shallow modules, duplicated source-of-truth logic, or tests coupled to implementation details; fix only when inside approved scope, otherwise report it.
- Run the repo architecture check when available, applicable, and required by the spec or repo policy.
- If `per-slice` applies and this phase completes an implementation slice, create and verify its checkpoint commit before continuing.
- Continue to the next phase only when the exit gate passes and no stop condition applies.
- If the phase exit gate says `User Pause: Required`, stop and wait for the user's explicit command.

## Review And Signoff

Do not run a dedicated review Runner-owned nodes after every phase by default. Do run one at explicit `Review Checkpoints`; these are risk gates, not optional status updates.

Before every reviewer launch, apply the Module's launch and reconciliation
rules to the persisted `## Implementation Review State`; do not restate or
replace those rules in this skill.

Run ``code-review`` as the final review gate when any of these apply:

- the spec explicitly requires it
- the repo policy requires it
- the change is medium or large
- the change touches multiple runtime files or shared behavior
- the change touches API contracts, DTOs, schemas, persistence, auth, permissions, payments, caching, concurrency, background jobs, or shared state

When ``code-review`` is required for a checkpoint or final gate, keep it at root so ``code-review`` can launch both `reviewer_deep` tracks in parallel. Invoking ``spec-implementer`` authorizes that review; if the role is unavailable, report the gate as unavailable/blocked instead of self-certifying it.

Run ``cleanup-review`` before final ``code-review`` when the spec or repo policy
requires both gates, in the exact order and modes scheduled by the Module.
Integrate safe cleanup fixes and rerun relevant validation before continuing.

For compact low-risk specs, final validation plus checklist reconciliation is enough unless the spec says otherwise.

Treat review feedback as mandatory remediation when it is grounded in code or the spec. If review reveals ambiguity that cannot be resolved from the spec, code, or docs, pause and ask the user.

Apply the Module's convergence and stop rules after every usable result and
before every new launch.

## multi-node Execution

- Use multiple agents only when the spec has explicit disjoint write scopes.
- Keep one integrator responsible for merge sequencing, handoff checks, final validation, and checklist reconciliation.
- Respect exclusive write scopes, handoff artifacts, forbidden overlap, and merge order exactly as written.
- Never let two agents edit the same file, generated artifact, schema, source-of-truth rule, or shared contract at the same time.
- If the spec lacks a clear integrator contract, execute single-agent or stop and ask for clarification.

## Stop Conditions

Stop immediately and escalate if:

- a required precondition cannot be satisfied exactly
- a required file, symbol, command, dependency, or interface differs from the spec
- the saved spec contains unresolved template text or alternative commands
- completing the task would require touching a Protected Path or using a Rejected Approach
- validation cannot prove the intended behavior with available repo context
- implementation would require unapproved scope, abstraction, migration, compatibility logic, or cleanup
- a `Risk Controls` rule would be violated or is contradicted by repo reality
- review exposes a real ambiguity that would require guessing
- a user pause is required and the user has not explicitly said to proceed

## Completion Standard

Do not mark the task complete until:

- completed checklist items are checked off according to the spec mode
- every remaining unchecked item is blocked, intentionally unfinished, not applicable, or halted by an explicit stop condition
- every reached phase exit gate has passed
- applicable `Risk Controls` remained satisfied
- reached Contract Test Ledger rows are green or explicitly blocked with evidence
- validation commands and behavior proof have run, or skipped checks have a concrete reason
- required review/signoff gates have run and grounded findings are fixed or blocked with evidence
- the whole-spec review budget, Review Plan, and stable defect lifecycle remain
  consistent with `implementation-review-loop.md`
- protected paths remained untouched and rejected approaches were not used
- required comments/docblocks were added only where the spec demanded them
- the chosen Git checkpoint strategy was followed, and every created or skipped checkpoint was recorded
- final user handoff is allowed by the spec

## Final Risk Handoff

For medium/high-risk specs, the final chat response must include a compact `Final Risk Handoff` block. Do not make the user ask for this separately, and do not replace it with a generic summary.

Include:

- **Contract implemented:** the one behavior/contract delivered, in user-facing terms.
- **High-risk checkpoints:** each required checkpoint, review result, fixed findings, and any stop/continue decision.
- **Main invariants proved:** the key Contract Test Ledger rows or equivalent proofs and their status.
- **Code-review findings:** high/critical findings fixed, remaining medium/low findings, or `none`.
- **Fixes after review:** concrete fixes made because of cleanup/code review, or `none`.
- **Validation:** exact commands/proofs that passed.
- **Skipped checks:** skipped or blocked checks with concrete reasons.
- **Residual risks:** accepted remaining risks or `none`.
- **Checkpoint commits:** slice-to-commit mapping, skipped checkpoint reasons, or `none`.
- **Implementation reviews:** profile, reviews used/budget, Full/Closure count,
  mandatory coverage, verified defect IDs, and open defect IDs.
- **Files by role:** state owner, orchestration, side effects, UI/projection, tests, docs/copy, as applicable.

Only create a separate report file when the spec requires it or the work is broad enough that chat would lose important evidence, such as multi-node execution, multiple review passes with findings, skipped live checks, production validation, or handoff to another person. Otherwise keep the spec checklist/ledger as the durable artifact and the final response as the concise decision packet.
