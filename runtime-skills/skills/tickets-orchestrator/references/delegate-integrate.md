### 3. Runner-route

For each issue in the active wave, route one worker Runner-owned nodes with a narrow ownership scope.

For a spec-gated wave, root first activates ``spec-implementer``, reconciles the
accepted spec checklist, and persists the Review Plan under `## Implementation Review State`.
Worker assignments implement explicit spec slices; root remains
the integrator and the only owner of review launches, budget accounting,
checklist updates, commits, and ticket delivery. For a no-spec wave, use the
direct ``tdd`` contract recorded in the wave ledger.

Each worker prompt must include:

- Parent issue reference and the worker's child issue reference.
- The accepted implementation spec reference when an issue-level or wave-level spec gate was run, and an instruction to follow it exactly unless repo reality creates a stop condition.
- Instruction to read repo policy and relevant docs before editing.
- Instruction to use ``tdd`` for behavior changes: write one behavior-first failing test, implement the smallest correct change, repeat, then refactor only while green.
- Instruction to report explicitly when no correct test seam exists, including why the available seams would give false confidence.
- When ownership or a public seam changes, instruction to apply ``improve-codebase-architecture`` principles while staying in scope: avoid shallow pass-through modules, prefer testing through the Module Interface, and report architecture friction instead of adding speculative seams. Omit this vocabulary when no boundary changes.
- Exact ownership boundaries and a warning that other agents may be editing the repo.
- Instruction not to revert, overwrite, or clean up changes made by others.
- Protected paths, rejected approaches, and out-of-scope items inherited from the parent issue.
- Required preconditions and verification command(s) for the touched area.
- Stop conditions: missing file/symbol/command, unmet precondition, overlapping write scope, unclear ownership, or validation that cannot be run.
- Required final report: changed files, proof per acceptance criterion, tests run, skipped checks, risks, blockers, and any unresolved unchecked acceptance criteria.
- For medium/high-risk child issues, required final report also includes contract implemented, main invariant proved, review-relevant risks, and residual risk.

While workers run, the orchestrator should do non-overlapping work: read docs, inspect ownership, map likely integration points, and prepare validation. Do not duplicate a worker's implementation.

### 4. Integrate each wave

Treat each wave as a hard execution gate.

When workers return:

1. Review their reports before touching code.
2. Review their diffs and verify they stayed within assigned scope.
3. Resolve conflicts without discarding user or worker changes.
4. Remove duplicated logic, competing source-of-truth changes, and workaround-shaped code.
5. Check for architecture drift: shallow modules, one-adapter seams, duplicated rules, or tests coupled to implementation details.
6. Reconcile the wave ledger: every active child issue is complete, blocked with evidence, or intentionally deferred.
7. Verify TDD evidence for behavior-changing issues: failing-before/passing-after test path, or a documented no-seam gap with rationale.
8. Run the smallest meaningful combined verification for the wave.
9. Run the repo architecture check when available and code changed.
10. Verify that implementation stayed inside the accepted spec when a spec gate was run, or document why a spec amendment was required.
11. For a spec-gated wave, execute each required checkpoint through the accepted spec's shared Implementation Review Loop. Every checkpoint, cleanup, final review track, and Closure consumes the same whole-spec budget; do not launch an orchestrator-owned duplicate review.
12. For a no-spec high-risk wave, run the repo-required ``code-review`` checkpoint with explicit Review Focus before starting dependent or lower-risk waves. Run any other review only when repo policy requires it.
13. Fix grounded findings in one consolidated batch and rerun needed validation. Spec-gated defect verification uses the Module's same-session Closure or a reserved covering Full reviewer.
14. Create focused commits for completed child issues, or one documented wave commit when safe separation is not possible.
15. For each completed child issue, post a concise GitHub comment with implementation result, commit reference, verification proof, skipped checks, and residual risk.
16. For medium/high-risk parent work, update the parent-level risk/proof ledger after each wave with checkpoint status, invariants proved, review findings/fixes, validation, skipped checks, and residual risks.
17. Close each completed child issue in GitHub after its comment is posted. Do not close blocked, deferred, uncommitted, or unverified issues.
18. If GitHub closure fails because of auth, network, permissions, or missing issue access, mark that issue as delivery-blocked and do not advance to dependent waves until the failure is resolved or the user explicitly accepts leaving it open.
19. Update the dependency graph and only then start the next wave.

If a worker reports an ambiguous or risky decision, pause and ask the user a targeted question before committing to that path.
