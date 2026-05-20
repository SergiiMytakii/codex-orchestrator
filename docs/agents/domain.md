# Domain Docs

This is a single-context repo.

## Before Exploring

Read these files when a task needs domain language or architectural context:

- `CONTEXT.md` at the repo root.
- Relevant ADRs in `docs/adr/`.
- `docs/deep-dive.md` for runner architecture and policy model.
- `docs/agents/execution-routing.md` for repo-specific execution and quality
  gates.

If a file is not relevant to the task, do not load it just to be exhaustive.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

There is no `CONTEXT-MAP.md`; do not assume multiple bounded contexts unless
the repo later introduces one.

## Vocabulary

Use the glossary terms from `CONTEXT.md`, especially the distinctions between
Runner, Agent, Review Gate, Acceptance Proof, Adaptive Proof Agent, Runner-Owned
Publication Boundary, and Draft PR Handoff.

Avoid replacing those terms with looser synonyms such as "AI project manager",
"publisher agent", or "done".

## ADR Conflicts

If a plan or implementation would contradict an ADR, call that out explicitly.
Current foundational ADRs include:

- `docs/adr/0001-runner-owned-loop-policy.md`
- `docs/adr/0002-adaptive-acceptance-proof.md`
