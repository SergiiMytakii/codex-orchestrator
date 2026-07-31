# Issue #1246 completion proof

## Historical checkpoint

This document records the exact #1246 checkpoint and is not final evidence for
#1242. Its former intermediate metrics and partial-suite statement are removed
to prevent them from being mistaken for final proof. The preserved B0 is
`7b2a002773dfc3faa87a28c4c5e60641bcb332bf`: 22,704 V2 production LOC and
4,142 lines in `src/v2/run-issue.ts`. Fresh final metrics, full-suite results,
owner/deletion evidence, and HEAD-bound smoke evidence belong to #1255.

## B0-to-#1246 deletion

B0 is `7b2a002773dfc3faa87a28c4c5e60641bcb332bf`. The preserved baseline was
22,704 V2 production LOC and 4,142 lines in `src/v2/run-issue.ts`.

The #1246 checkpoint measurements were:

```text
git ls-files 'src/v2/*.ts' 'src/v2/**/*.ts' | LC_ALL=C sort | xargs wc -l
20780 total

wc -l src/v2/run-issue.ts
3827 src/v2/run-issue.ts
```

At that checkpoint the graph deleted 1,924 net V2 production lines and 315 `RunIssue`
lines. The B0 production diff is 2,995 insertions and 4,919 deletions. The only
#1246 production edit is the existing spec-author prompt projection needed to
carry a trusted answer into the same Run; it adds no owner or lifecycle.

## Owner and mechanism map

Before the graph, lifecycle/progression was distributed across operation-
specific invocation records, proof state/store, waiting-human state,
qualification repair, Full/Closure review, and a separate post-PR phase.

After the graph, the exact durable state identifier is
`codex-orchestrator.run-state`. The only Run-lifecycle owners are:

1. one `RunRecord`;
2. at most one operation-neutral `ActiveAttempt`;
3. at most one `PendingEffect`.

Repository/atomic owner locks, candidate pins/materializations, and Android/iOS
device leases remain bounded safety resources. They authorize or contain one
effect but do not own progression. Production absence searches return no
qualification-repair, closure request hash, ReviewFeedbackCoordinator,
execution lease, proof store, V3 state, migration, awaiting-user route, or
affected-only mechanism.

Unsupported state remains effect-free before owner-lock acquisition; after the
lock, progression requires a fresh authoritative reread.

## Historical checks and fault matrix

- Focused final contract sets: 33/33 live-smoke harness, 50/50 report/schema,
  and 2/2 trusted-answer/same-Run tests passed.
- Workflow generation tests: 21/21 passed; checked-in workflow verification
  and `git diff --check` passed.
- Package dry-run produced `codex-orchestrator-2.0.10.tgz` with 288 entries.
- Final full-suite evidence is intentionally not claimed by this historical
  checkpoint; #1255 owns the fresh complete run on the final HEAD.

Across the full and focused sets, the matrix covers launch authorization,
result adoption, every PendingEffect/CAS boundary, candidate cleanup and
publication, PID reuse/process-group absence, daemon discovery freshness,
issue isolation, terminal replay, and exactly-once semantic budget spend.

## Packed scratch smoke

Authenticated `gh` and Codex preflight passed. Every run was restricted to
`SergiiMytakii/codex-orchestrator-live-smoke` and held the fixed exclusive
scratch lock. The production repository and caller-supplied target/work roots
are rejected.

Real packed Luna-backed successes:

- direct/package-install: 4 model calls — triage, implementation, one complete
  review, proof;
- spec-first: 6 — direct calls plus exactly spec-author and spec-review before
  implementation authority;
- product-question: 7 — one frozen question and one answer-authoring call,
  then spec review and the normal delivery loop in the same Run;
- trusted post-PR: 7 total — initial direct 4 plus one feedback implementation,
  one complete review, and one proof on the same PR.

There were no extra happy-path retries, reviews, checks, waits, or daemon ticks.
The post-PR smoke also proved one fast-forward commit, one existing PR, refreshed
check/proof bindings, one summary marker, and effect-free replay.

Live smoke exposed and fixed two source-authorized generation bugs: the triage
schema lacked the standard root report envelope, and spec-review defects used
an invalid unconstrained object. It also exposed that the contained spec-author
prompt omitted the already-persisted trusted answer. Each fix reuses an existing
contract; none adds compatibility or orchestration machinery.

Strict cleanup returned the scratch repository to zero run-owned open issues,
PRs, branches, labels, or lock refs. Local process/ref/worktree checks passed,
all diagnostic run roots were removed, and the final harness now emits its
report before deleting the complete read-only temporary root. No release,
push, publish, consumer update, production smoke, daemon restart, or external
rollout was performed.
