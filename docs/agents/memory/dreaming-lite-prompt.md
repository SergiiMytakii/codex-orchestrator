# Dreaming-Lite Maintenance Prompt

Use this prompt for a manual pass or a scheduled Codex automation.

```text
Run a codex-orchestrator Dreaming-lite memory pass.

Read:
- AGENTS.md
- docs/agents/execution-routing.md
- docs/agents/memory/README.md
- docs/agents/memory/lessons.md

Inspect only bounded local evidence for the requested window:
- recent git history from the last 7 days;
- recent docs, implementation specs, plans, and ADRs;
- local self-improvement summaries already present in the repo;
- local test/typecheck outputs already present as files;
- current lessons in docs/agents/memory/lessons.md.

Do not scan unrelated logs, production systems, GitHub, Slack, databases, or
external APIs unless the user explicitly asks or the automation prompt allows
that evidence source.

Maintain docs/agents/memory/lessons.md:
1. add narrow evidence-backed lessons using the required template;
2. rewrite overly long lessons into compact entries;
3. deduplicate older entries;
4. retire stale or superseded lessons;
5. report any items that should be promoted to AGENTS.md,
   docs/agents/execution-routing.md, docs/deep-dive.md, an ADR, a prompt, or a
   local skill.

Rules:
- keep entries evidence-backed and narrow;
- do not store secrets, credentials, tokens, customer-private data, or long logs;
- separate confirmed facts from inference;
- prefer one high-signal entry over several vague entries.
```
