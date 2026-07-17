# Bug Workflow Routing

Use the bug skills by user intent and feedback-loop quality:

- `bug-root-cause-explainer`: diagnosis-only. Use when the user asks why, wants root cause, options, or no edits. Stop before implementation.
- `diagnosing-bugs`: feedback-loop builder. Use when the bug is hard, flaky, unclear, performance-related, or cannot be proven with a tight red/green signal.
- `code-debugger`: implementation. Use when the user asks to fix, chose a fix path, or the bug is obvious and reproducible.

Handoffs:

- Explainer -> Diagnosing Bugs when root cause cannot be proven without a reliable loop.
- Explainer -> Code Debugger after the user chooses a fix path.
- Code Debugger -> Diagnosing Bugs when implementation discovers the bug is unclear, flaky, or lacks a red-capable signal.
- Diagnosing Bugs -> original intent: return diagnosis to the explainer path, or apply the fix through Code Debugger.

Inside an active user-authorized implementation/TDD flow, keep a reviewer repair
in that same TDD activation only when the defect is high-confidence,
source-required, inside the approved behavior/Seam, and has bounded trigger,
cause, and repair. Group related cases by protected invariant before one
consolidated repair batch. New product intent, a new Seam, or a risky trade-off
stops for user approval. A separately authorized fix with no active flow, or an
ambiguous reproduction/cause/repair, still routes through `code-debugger`.

Do not collapse diagnosis-only, feedback-loop construction, and implementation into one response unless the user explicitly asked for that full flow.
