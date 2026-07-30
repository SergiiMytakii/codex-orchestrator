# Domain documentation routing

This repository has one bounded context: the controlled delivery of one
authorized GitHub Issue by a trusted Runner and contained Codex workers.

## Authorities

Read only the authority needed for the task:

- `CONTEXT.md` owns the glossary and durable domain relationships.
- Relevant ADRs in `docs/adr/` own accepted architectural decisions.
- Current code, configuration, and tests own implemented Runner behavior.
- `docs/agents/execution-routing.md` for repo-specific execution and quality
  gates.

`docs/deep-dive.md` is a human-maintainer guide. Agents must not read or use it
as context unless the user explicitly asks to edit or audit that file.

## Vocabulary

Use the exact glossary terms from `CONTEXT.md`, especially Runner, Agent, Run,
Checked Change, Acceptance Proof, Runner-owned action, Safe halt, and
Review-ready.

Avoid replacing those terms with looser synonyms such as "AI project manager",
"publisher agent", or "done".

## ADR Conflicts

If a plan or implementation would contradict an ADR, call that out explicitly.
Current foundational ADRs include:

- `docs/adr/0001-runner-owned-loop-policy.md`
- `docs/adr/0002-adaptive-acceptance-proof.md`

Review this routing document when the repository introduces another bounded
context, changes glossary ownership, or accepts or supersedes a foundational
ADR.
