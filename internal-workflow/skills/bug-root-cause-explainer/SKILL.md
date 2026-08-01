---
name: bug-root-cause-explainer
description: "Diagnose and explain a bug without editing code. Use for why/root-cause requests or when the user says not to fix yet; validate the issue, trace ownership, explain with evidence, and offer a proportional fix path."
---

# Bug Root Cause Explainer

## Overview

Use this skill when the main deliverable is understanding, not an immediate patch. Prove the issue, find the owning cause, explain it simply, propose the smallest safe path, and wait for the user's decision.

## Core Rule

Do not jump into implementation. Finish the diagnosis, offer one minimal path,
and stop. Add a structural path only when evidence proves an ownership defect
that the minimal fix leaves in place.

For routing between bug diagnosis, feedback-loop construction, and implementation, use `../../docs/agents/bug-workflow-routing.md`.

Use `implement` instead when the user wants an end-to-end debug-and-fix flow in one pass.
After the user chooses a path, hand off implementation to `implement`.

If the bug is hard, flaky, performance-related, or lacks a reliable feedback loop, use `diagnosing-bugs` before choosing a fix path. Do not guess a root cause without evidence.

Use `../../docs/agents/confidence-rubric.md` to label root-cause certainty. If the evidence is low-confidence, present it as an uncertainty or verification gap instead of a proven cause.

## Investigation Workflow

1. Validate the bug before believing the report.
   - Reproduce the issue when possible.
   - If full reproduction is expensive, recover the strongest available signal: failing test, runtime log, broken response, visible UI behavior, or deterministic code-path contradiction.
   - If the report is outdated, incorrect, or actually expected behavior, say so clearly and stop there.

2. Trace the owning path.
   - Follow the real execution path instead of reading files broadly.
   - Identify the exact entrypoint, decision point, state mutation, async boundary, and downstream effect that create the symptom.
   - Prefer the owner module over secondary symptoms. Do not anchor the diagnosis in the last place where the bad data merely becomes visible.

3. Separate symptom from root cause.
   - State what the user sees.
   - State what the code is actually doing.
   - State where those two paths diverge.
   - If there are multiple contributing issues, name the primary cause first and list the others only as amplifiers.

4. Translate the diagnosis into plain language.
   - Explain the issue as if speaking to a product-minded teammate, not only to the author of the code.
   - Keep the explanation concrete and simple.
   - Avoid jargon when possible.
   - When jargon is unavoidable, define it in one short sentence.

5. Support the explanation with exact references.
   - Always cite the concrete file and function or method where the problem starts.
   - Add a second reference for the downstream effect when that makes the explanation clearer.
   - Include line references when they materially help the reader verify the claim.

6. Offer proportional solution paths.
   - Before proposing fixes for a confirmed bug, apply `../../docs/agents/bugfix-quality-gate.md`: state the invariant, diagnosis boundary, adjacent paths not inspected, and what the evidence does not prove.
   - Always offer the smallest safe fix.
   - Add one structural path only for a proven ownership defect; tie its scope to that evidence.

7. Stop and wait.
   - Ask whether to implement the path, or which path when two are justified.
   - Do not edit code, write files, or stage changes after the diagnosis unless the user explicitly chooses a path or explicitly asks for implementation.

## Explanation Rules

- Prefer short paragraphs over dense technical dumps.
- Answer the hidden user questions directly:
  - What is broken?
  - Why is it happening?
  - Where exactly in the code does it start?
  - Why does it show up in this specific way?
- Use concrete phrasing like "the code throws away X here" or "this branch never runs because Y is always false here".
- Avoid vague language like "there may be a race" unless you can point to the exact competing operations.
- Avoid speculative fixes before the root cause is proven.

## Output Contract

Use this shape when reporting back:

```md
## What is happening

<Very simple explanation of the real problem in plain language. Keep it short and concrete.>

## Where it starts in code

- `<path>` — `<function or method>`: <what this code is doing wrong>
- `<path>` — `<function or method>`: <how the bad state reaches the visible symptom>

## Why the symptom looks like this

<Short explanation connecting cause to symptom.>

## Fix path

1. Minimal path
   - Scope: <smallest change>
   - Tradeoff: <what this solves and what it does not improve>

2. Structural path (only for a proven ownership defect)
   - Scope: <cleaner ownership fix with minimal necessary breadth>
   - Tradeoff: <why this is better long-term and what extra work it needs>

## Decision

Do you want me to implement this path?
```

## Escalation Rules

- If the evidence is still ambiguous after careful tracing, present the ambiguity explicitly instead of pretending the root cause is proven.
- If multiple fixes are valid but change product behavior differently, say that the choice is product-sensitive and ask the user to choose.
- If the issue is security-critical or can cause data loss, say so clearly before presenting the two paths.
