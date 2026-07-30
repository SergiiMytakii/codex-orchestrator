# Issue #1243 completion proof

## Baseline and deletion result

The immutable pre-edit baseline is commit
`7b2a002773dfc3faa87a28c4c5e60641bcb332bf`, V2 production `22704` LOC, and
`src/v2/run-issue.ts` `4142` LOC.

The same production measurements after implementation are:

```text
git ls-files 'src/v2/*.ts' 'src/v2/**/*.ts' | LC_ALL=C sort | xargs wc -l
22578 total

wc -l src/v2/run-issue.ts
4141 src/v2/run-issue.ts
```

This is a net deletion of 126 V2 production lines and one line from
`RunIssue`, despite adding the operation-neutral attempt kernel, exact process
identity, daemon isolation, and state projection module. `proof-store.ts` is
deleted.

## Owner and mechanism proof

The exact durable schema is `codex-orchestrator.run-state`. The only Run
lifecycle owners are the Run, at most one `ActiveAttempt`, and at most one
`PendingEffect`. Repository/atomic locks, candidate pins/materializations, and
device leases remain finite resources without lifecycle progression.

Production absence searches returned no matches for the old schema, V3
migration/rollback/backup symbols, proof state/store types, operation-specific
invocation owners, candidate execution lease, qualification repair invocation,
or nested durable `process`/`intent` fields in the semantic records.

Unsupported or malformed state is inspected before owner-lock acquisition and
returns `state-schema-unsupported` without creating state, evidence, lock,
worktree, Git, or GitHub effects. A fresh authoritative inspection after the
lock is required before progression.

## Verification

- TypeScript production build: passed.
- ActiveAttempt, process identity, daemon tick, and exact Run-store contracts:
  30/30 passed.
- Final review-repair fault set covering terminal replay, same-Run trusted PR
  feedback, every durable effect rejection, unknown candidate CAS, and
  candidate proof recovery: 5/5 passed.
- Earlier focused state/spec/waiting/check set: 41/41 passed.
- Final seven public review-fault scenarios were reduced to the five repaired
  defects above; all repaired scenarios pass without a full-suite rerun.
- `git diff --check`: passed.

The independent high-profile review defects were closed by durable result
adoption, launch authorization, worktree/evidence PendingEffects, descendant
process-group quiescence, removal of label-first legacy fallback, and atomic
blocked/outcome effect transitions. No workflow engine, queue, cache, retry
coordinator, classifier, compatibility runtime, or additional lifecycle owner
was added.

`check:workflow` remains externally blocked by the user-global
`~/.codex/docs/agents/coding-skill-evals.json` using unsupported
`event_values_equal`; repository workflow sources were not changed by #1243.
