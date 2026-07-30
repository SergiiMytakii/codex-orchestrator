# Issue #1246 compact implementation spec

## Outcome

Prove the simplified V2 flow from the immutable #1243 baseline through the
current package and a controlled packed scratch-repository smoke.

## Change

- Update the live-smoke harness to the exact run-state schema, the single full
  review contract, and Run-owned post-PR feedback data.
- Add direct, spec-first, product-question/spec-frozen, and trusted post-PR
  packed scenarios without adding production lifecycle machinery.
- Require authenticated GitHub/Codex preflight, the configured scratch repo,
  exclusive remote lock ownership, and cleanup of run-created issues, PRs,
  branches, labels, candidate refs/worktrees, processes, and temporary data.
- Remove stale V3, qualification, Full/Closure, and separate post-PR lifecycle
  language from the smoke checklist.

## Proof

Run focused smoke-harness tests while editing. Then run the full package suite
exactly once, execute one packed four-scenario live smoke, record the fault and
owner maps, compare final V2 and `RunIssue` LOC to B0, and commit/close #1246
only after all proof is present. No push, release, publish, consumer update,
production smoke, daemon restart, migration, or compatibility runtime.
