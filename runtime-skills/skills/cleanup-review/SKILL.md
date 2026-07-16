---
name: "cleanup-review"
description: "Run a post-implementation hygiene review before final code review to detect duplicated logic, dead or legacy code, workaround-shaped branches, missed cleanup, and obsolete paths that should be removed. Use for medium and large changes before ``code-review``, especially when multiple runtime files, shared logic, or architectural boundaries were touched."
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

# Cleanup Review

Use this skill after implementation and before final ``code-review`` for medium and large changes.

For approved spec execution, follow
`../../shared/docs/agents/implementation-review-loop.md`. Cleanup is a final hygiene
Adapter inside that whole-spec budget, not a recursive prerequisite for every
intermediate checkpoint.

This is not a bug review. Its job is to check whether the implementation left behind duplication, obsolete paths, workaround-shaped logic, or cleanup debt that should be removed before the final ``code-review``.

## Invocation Mode

- Use one `reviewer_deep` under the shared routing policy for medium and large changes; invoking ``cleanup-review`` authorizes this gate.
- The main implementation agent stays responsible for integrating safe cleanup fixes.
- Run inline only inside `reviewer_deep`.
- If the role is unavailable or the user forbids Runner-owned nodes, report the independent cleanup gate as unavailable; do not self-certify inline.
- Under spec execution, run only when the persisted Review Plan schedules this
  Adapter, using the assigned mode and reviewer session. Do not independently
  schedule a cleanup pass or its follow-up.

## What To Check

- Logic duplicated instead of reused or extracted.
- Legacy branches, compatibility shims, or fallback paths that are no longer needed.
- Dead code, obsolete helpers, unused flags, and stale adapters left after the new flow landed.
- Workaround-shaped conditionals, one-off guards, magic ordering, or patch-the-symptom code.
- Claim drift: code fixes one path, but tests/docs/final notes imply the whole behavior class is fixed.
- Missing cleanup of replaced code paths, comments, tests, docs, or registrations.
- Ownership drift: logic added in the wrong layer when the owner abstraction should have been extended.
- Shallow modules that fail the deletion test.
- One-adapter seams introduced without a current need.
- Tests coupled to implementation details instead of the Module Interface.

## Review Rules

- Prefer a small number of concrete, high-signal findings.
- Default to removal and simplification when it is safe.
- Do not ask for extra abstraction unless it clearly reduces duplication or restores ownership.
- Treat "tests pass" as insufficient if the code now has two sources of truth or keeps dead paths alive.
- Run/report the repo architecture check when available and cleanup touched code.
- If a cleanup change is high-confidence and low-risk, return the proposed fix to the root for integration.
- If removal risk is unclear, report it with exact evidence instead of guessing.
- For a Module-scheduled `Closure`, apply its bounded Closure capsule exactly.

## Output

Always answer in this structure:

1. `Verdict: Clean / Cleanup Needed / Cleanup Blocked`
2. `Findings` with concrete duplication, legacy, or cleanup issues.
3. `Safe Fixes Proposed` with fixes the root can integrate safely.
4. `Follow-up Needed` with only unresolved cleanup decisions or risky removals.

Keep the output short. This skill is a final hygiene gate, not a broad architecture essay.
