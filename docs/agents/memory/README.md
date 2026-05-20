# codex-orchestrator Dreaming-Lite Memory

This directory is the repo-local, curated memory layer for `codex-orchestrator`
agent work. It captures verified lessons that are useful across future Codex
threads but are not strong enough, stable enough, or broad enough to become
`AGENTS.md`, an ADR, `docs/deep-dive.md`, or a reusable skill yet.

Use this layer as a small recall cache. Do not treat it as the source of truth
for mandatory behavior.

## When To Read

Read this directory only when the task involves one of these patterns:

- repeated runner, daemon, recovery, proof, publication, or review-gate issues;
- repeated mistakes in local self-improvement, GitHub issue automation, or draft
  PR handoff workflows;
- repeated test/typecheck failures or fixture setup pitfalls;
- recently learned project pitfalls that are not yet promoted into formal docs.

For normal coding tasks, first use `AGENTS.md`, `docs/agents/execution-routing.md`,
`docs/deep-dive.md`, and relevant ADRs. Load memory files only when the task
suggests that recent lessons may matter.

## Files

- [lessons.md](./lessons.md) - curated package lessons, newest first.
- [entry-template.md](./entry-template.md) - required format for new entries.
- [dreaming-lite-prompt.md](./dreaming-lite-prompt.md) - prompt for a manual or
  scheduled maintenance pass.

## Entry Rules

Every lesson must be evidence-backed and narrow.

Required fields:

- date;
- scope;
- evidence;
- lesson;
- use when;
- do not use when;
- review after.

Do not add secrets, raw credentials, GitHub tokens, customer-private data, long
logs, or large transcripts. Link to the source artifact or summarize only the
useful operational pattern.

## Promotion Rules

Promote a memory entry out of this directory when it becomes a durable rule:

- mandatory agent behavior -> `AGENTS.md` or `docs/agents/execution-routing.md`;
- runner architecture or policy -> `docs/deep-dive.md`;
- architecture decision -> `docs/adr/`;
- reusable project procedure -> a prompt or skill;
- release-facing behavior -> `CHANGELOG.md` or release notes when appropriate.

Delete or rewrite entries that become stale. A stale memory is worse than no
memory because agents may trust it during debugging.

## Maintenance

Run a Dreaming-lite pass after a cluster of related incidents or at most weekly
when the package has active agent work.

The pass should:

1. inspect recent relevant implementation specs, plans, local self-improvement
   outputs, issue automation summaries, and test/typecheck failures;
2. propose or apply a small diff to [lessons.md](./lessons.md), depending on the
   run mode;
3. deduplicate older entries;
4. remove stale entries past their review date;
5. report durable rules that should be promoted into the owning source-of-truth
   doc instead of leaving them here.
