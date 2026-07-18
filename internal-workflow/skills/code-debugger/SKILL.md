---
name: code-debugger
description: Implement and verify an explicit or approved bug fix end-to-end. Use for fix requests or after diagnosis; not for explanation-only work, which uses `bug-root-cause-explainer`.
---

# Code Debugger

## Overview

Treat every bug report as an engineering investigation, not a prompt to guess. Start by proving whether each reported problem is valid and still current, then narrow the failing path, patch the root cause with the smallest correct change, and verify the result before closing the task. Always plan your actions explicitly before executing them.

For confirmed contract defects, use the shared Contract Test Ledger at `../../docs/agents/contract-test-ledger.md`.

## Activation Rule

Use this skill only when the user wants implementation.

For routing between bug diagnosis, feedback-loop construction, and implementation, use `../../docs/agents/bug-workflow-routing.md`.

- If the user wants diagnosis, explanation, or options first, use `bug-root-cause-explainer`.
- If the user reports a hard, flaky, performance-related, or unclear bug without a reliable feedback loop, use `diagnosing-bugs`.
- If the user already chose a fix path, implement that path here.
- Reviewer repairs already owned by an active authorized TDD flow stay in that flow under `bug-workflow-routing.md`; use this skill for separate fixes or ambiguous reproduction/cause/repair.

## Debugging Workflow

Default execution mode is inline; use `analyst_deep` only while causal or contract ambiguity remains unresolved.

1. Triage every reported issue before accepting it as a bug.
   - Do not assume a reported problem is correct, current, or reproducible.
   - Check whether the report refers to code that has already changed, a misunderstanding of intended behavior, a stale environment, or a non-issue.
   - Classify each item explicitly: confirmed bug, not reproducible yet, outdated, expected behavior, duplicate, or blocked.
   - Only move to implementation once there is evidence that the issue is real.

2. Define the failure precisely.
   - Extract the actual symptom, expected behavior, affected surface, and reproduction hints from the user request, logs, screenshots, tests, or commands.
   - Convert vague reports into a concrete statement: what is broken, where it happens, and under which input.

3. Build a complete issue ledger when multiple bugs are reported.
   - Enumerate every reported item before fixing anything.
   - Track status for each entry (triage, reproduced, fixing, verified, invalid, blocked).
   - Process items one by one, but keep the full ledger visible.

4. Reproduce or recover a failing signal.
   - Prefer the narrowest reliable proof: a failing test, local command, runtime log, or API response.
   - Inspect existing running processes before starting duplicate services.
   - If full reproduction is impossible, establish the strongest available failing signal and state what is missing.
   - If no red-capable signal can be built for an unclear or flaky bug, switch to `diagnosing-bugs` before patching.

5. Create the regression contract row for confirmed defects.
   - For each confirmed review finding or contract bug, record the invariant, the concrete risk, and the first regression test/proof before patching.
   - The preferred sequence is `planned -> red -> green`: show the regression signal fails, apply the fix, then verify it passes.
   - If no correct public seam exists, mark the ledger row `blocked` with the missing seam or fixture instead of writing an implementation-detail test by default.

6. Build context before editing.
   - Read local docs, runbooks, or feature notes first.
   - Trace the execution path through entrypoints, callers, state writes, async boundaries, DTOs, and external integrations.
   - Inspect nearby modules that can invalidate assumptions.
   - If a prior `bug-root-cause-explainer` diagnosis exists, treat it as the starting point, then verify the key claim in code before changing anything.

7. Identify the root cause.
   - Separate the symptom from the defect that causes it.
   - **Environment Check:** Always verify the versions of relevant dependencies (`package.json`, `requirements.txt`, `go.mod`, etc.). A bug might be a known issue in a specific library version.
   - When framework or library behavior is material to the fix, consult official documentation or your knowledge base tools.

8. Implement the smallest correct fix.
   - Before editing a confirmed bug, apply `../../docs/agents/bugfix-quality-gate.md`.
   - Fix the root cause instead of masking the symptom.
   - Preserve existing architecture and local code patterns.
   - Avoid unrelated refactors while debugging.
   - Add or update a regression test when feasible.

9. Verify the outcome.
   - Run the narrowest meaningful checks: targeted tests, lint, build, or log inspection.
   - Verify the final observable outcome, not only an intermediate flag, event, queue item, callback, or response.
   - Compare the signal before and after the fix.

10. Report with evidence.
   - State the root cause, the fix, and exactly how it was verified.
   - Call out anything that could not be verified and why.
   - If the fix follows a user-approved path from `bug-root-cause-explainer`, say which path was implemented.

## Operating Rules

- **Chain of Thought:** Before executing any commands, reading files, or modifying code, write a `<thinking>` block outlining your immediate next steps and hypotheses.
- **Safety Rails:** NEVER run destructive commands (e.g., `rm -rf`, `DROP TABLE`, destructive Git resets) without explicit user confirmation. For database debugging, strictly use `SELECT` or read-only transactions.
- **Anti-Loop Mechanism:** If you fail to reproduce a bug or pass a test after 3 consecutive attempts, STOP making blind changes. Output a summary of what you tried, identify the current blocker, and explicitly ask the user for guidance or missing context.
- Prefer repository evidence over speculation.
- Prefer validating a report before treating it as ground truth.
- Prefer fast text searches (like `rg` or `grep`) over broad file reads.
- Prefer exact commands and exact failing conditions over summaries.
- If a user report is underspecified, infer from code, tests, logs, and docs first; ask questions only when a safe next step cannot be discovered.
- If the bug is intermittent or flaky, look for race conditions, shared mutable state, retries, timing assumptions, and missing cleanup.

## Failure Modes To Check Aggressively

- Wrong branch or inverted condition
- Missing `await` or broken async ordering
- Null, undefined, or empty-state handling
- DTO or schema drift across module boundaries
- Cache invalidation or stale state
- Timezone, locale, or unit conversion errors
- Partial writes and inconsistent side effects
- Retry duplication or non-idempotent background work
- Broken loading, error, or optimistic UI states
- Incorrect assumptions about framework defaults or recent library behavior

## Output Contract & Multi-Issue Response Template

When the user reports multiple bugs or findings at once, present and maintain a ledger in this streamlined shape before and after implementation. Keep the table compact to prevent formatting errors, and place detailed plans below it.

```md
## Issue Ledger

| # | Issue | Verdict | Status | Verification |
|---|---|---|---|---|
| 1 | <short restatement> | confirmed bug / outdated / duplicate / blocked | triage / reproduced / fixing / verified / blocked | <test, log, command, or n/a> |
| 2 | <short restatement> | ... | ... | ... |

### Details & Plans
* **Issue 1:** <Plan, root cause, and next action>
* **Issue 2:** <Plan, root cause, and next action>
