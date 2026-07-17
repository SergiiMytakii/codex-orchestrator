---
name: "spec-implementer"
description: "Executes approved specs continuously with honest checklist updates, proportional validation, opt-in Git checkpoints, and required review/signoff."
---

# Spec Implementer

Execute an approved implementation spec. Your job is to carry out the chosen spec, keep its checklist honest, and stop at the right boundaries. Do not redesign the work unless the spec or repo reality proves a blocker.

This skill is standalone by default: it executes only an approved spec that the
user has chosen to run. `$tickets-orchestrator` may invoke it inline at root for
an accepted compact or standard ticket spec inside user-authorized orchestration;
that does not authorize unrelated specs or broader delivery scope.

When a spec contains a Contract Test Ledger, treat it as part of the execution contract. The shared reference is `../../docs/agents/contract-test-ledger.md`.

All implementation review checkpoints and final review gates use
`../../docs/agents/implementation-review-loop.md` as their caller-facing owner.
This skill must not create a per-slice review flow or retry loop.

## Spec Modes

- **Compact specs:** execute directly as one continuous implementation flow with lightweight phase checkpoints. `compact` describes document density, not implementation size or risk. Use review/signoff gates only when the spec, repo policy, or change risk requires them.
- **Full specs:** execute the same phase flow, but treat `Risk Controls`, task-specific `Halt Conditions`, and validation proof as hard constraints. Do not invent extra process just because the spec is full.
- **Multi-agent specs:** follow the integrator contract exactly. If write scopes are not perfectly disjoint, stop before spawning workers.

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
10. Apply the `$codebase-design` lens only when ownership or a public Module Interface or Seam changes. For any new private helper, run the deletion test and keep it only if it improves locality or leverage, without activating architecture workflow.
11. Do not add pass-through modules, one-adapter seams, or test-only helpers unless the spec explicitly approves them.
12. Add comments/docblocks only where the spec explicitly requires them.

## Before Editing

- Read the complete frontmatter before announcing execution strategy. Confirm the spec path, status, `spec_mode`, `implementation_size`, `review_profile`, and `expected_repositories`; infer a missing classification from evidence without rewriting the approved design.
- Identify whether it is compact, full, or multi-agent. Do not call a compact spec full or equate compact with small.
- Check required services, env vars, fixtures, repo state, and prerequisite issues.
- Confirm the first phase targets exist as described.
- Confirm validation commands are executable or explicitly not applicable.
- If the spec has a Contract Test Ledger, confirm each reached invariant has a first test/proof or a concrete blocked reason before implementation.
- If the spec has `Review Checkpoints` or `Review Focus`, keep only checkpoints whose target becomes stable before later slices. If later work will touch the same files, owners, or contracts, fold that coverage into the final parallel review instead of reviewing an unstable slice.
- Resolve the implementation review profile and plan mandatory final coverage before launching any reviewer. Do not manufacture an early checkpoint merely because the profile is high.
- Do not write `## Implementation Review State` during ordinary preflight or implementation. Immediately before the first actual reviewer launch, persist the short Review Plan and pending launch required by the Module; then update it after every usable reviewer result, repair batch, closure, waiver, or terminal outcome.
- If the spec has `Final Handoff Requirements`, treat them as the final response contract. For medium/high-risk specs without explicit requirements, prepare the standard Final Risk Handoff anyway.
- For full specs, read `Risk Controls` before editing and translate each applicable control into a concrete execution constraint.
- Use `Write Scope Summary` when present as an audit aid. If it is absent, rely on phase targets unless the write set is ambiguous.
- Stop if exact execution would require guessing.

## Git Checkpoints

Default to `none` and begin implementation without checkpoint ceremony. Mention the strategy once only when it materially affects delivery. Invoking `$spec-implementer` does not by itself authorize commits.

Choose `per-slice` only when commits are explicitly authorized by the user or approved spec, slice diffs are truly isolated, and checkpoints materially improve recovery or handoff safety. Valid reasons are:

- a multi-agent merge/handoff boundary
- an explicitly planned pause or continuation in another session
- a destructive or rollback boundary whose isolated commit is part of the approved safety plan

Use `none` for ordinary single-agent execution, including compact/high specs, overlapping slices, and continuous work in one session. Slice count, file count, or review profile alone never justifies commits.

At each checkpoint:

- require a passed exit gate and applicable slice review, then reconcile and include tracked checklist/ledger updates
- inspect the full diff, stage only slice-owned paths or hunks, follow `$commit` safety rules, and verify the hash
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
  Module only when the target is settled and later slices do not invalidate its
  files/contracts. Otherwise record that its lenses moved to final coverage and
  continue without launching an unstable review.
- Reconcile unchecked items for the current phase.
- Re-check applicable `Risk Controls` before leaving the phase.
- Check whether the phase introduced shallow modules, duplicated source-of-truth logic, or tests coupled to implementation details; fix only when inside approved scope, otherwise report it.
- Run the repo architecture check when available, applicable, and required by the spec or repo policy.
- If `per-slice` applies and this phase completes an implementation slice, create and verify its checkpoint commit before continuing.
- Continue to the next phase only when the exit gate passes and no stop condition applies.
- If the phase exit gate says `User Pause: Required`, stop and wait for the user's explicit command.

## Review And Signoff

Do not run a dedicated review subagent after every phase by default. Do run one at explicit `Review Checkpoints`; these are risk gates, not optional status updates.

Before every reviewer launch, apply the Module's launch and reconciliation
rules to the persisted `## Implementation Review State`; do not restate or
replace those rules in this skill.

Require final `$code-review` coverage when any of these apply:

- the spec explicitly requires it
- the repo policy requires it
- the change is medium or large
- the change touches multiple runtime files or shared behavior
- the change touches API contracts, DTOs, schemas, persistence, auth, permissions, payments, caching, concurrency, background jobs, or shared state

When `$code-review` is required for a checkpoint or final gate, keep orchestration at root so `$code-review` can launch the profile-selected reviewer topology. Invoking `$spec-implementer` authorizes that review; if the required role is unavailable, report the gate as unavailable/blocked instead of self-certifying it.

Use one final `$code-review` wave after the implementation and validation settle.
For `simple` and `medium`, one reviewer covers both lenses. For `high`, launch
the correctness and spec/standards reviewers in parallel; the spec/standards
lens includes bounded cleanup. Run separate `$cleanup-review` only when the
user, approved source, or repo policy names a concrete evidenced reason that
cannot fit that lens; size or risk labels alone are insufficient. Integrate safe
fixes and rerun relevant validation before continuing.
Before launching a fresh final reviewer, reconcile the settled revision against
the Review Plan. Stop when an approved Full or Closure already covers every
mandatory final lens; otherwise run `$code-review` only for the uncovered
lenses. A `cleanup-only` result never substitutes for correctness or
spec/standards coverage.

For compact low-risk specs, final validation plus checklist reconciliation is enough unless the spec says otherwise.

Treat review feedback as mandatory remediation when it is grounded in code or the spec. If review reveals ambiguity that cannot be resolved from the spec, code, or docs, pause and ask the user.

Apply the Module's convergence and stop rules after every usable result and
before every new launch.

## Multi-Agent Execution

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
- the whole-spec Review Plan, review-pass history, and stable defect lifecycle remain
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
- **Checkpoint commits:** slice-to-commit mapping or `none`; do not narrate hypothetical checkpoints that were never authorized or attempted.
- **Implementation reviews:** profile, total review passes, Full/Closure count,
  mandatory coverage, verified defect IDs, accepted-risk IDs with authority and
  reason, and open defect IDs.
- **Files by role:** state owner, orchestration, side effects, UI/projection, tests, docs/copy, as applicable.

Only create a separate report file when the spec requires it or the work is broad enough that chat would lose important evidence, such as multi-agent execution, multiple review passes with findings, skipped live checks, production validation, or handoff to another person. Otherwise keep the spec checklist/ledger as the durable artifact and the final response as the concise decision packet.
