# Design It Twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, use this parallel sub-agent pattern. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best.

Uses the vocabulary in [SKILL.md](./SKILL.md) — `module`, `interface`, `seam`, `adapter`, `leverage`.

Run this workflow only when the candidate is selected, its constraints are known, and the interface decision is consequential enough to justify independent alternatives. Do not run it for a vocabulary question, one bounded recommendation, or routine helper extraction.

This file defines the comparison protocol; the active root driver executes it and retains session ownership, user dialogue, delegation, and the final decision.

## Process

### 1. Frame the problem space

Before delegation, the active root driver writes a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](./DEEPENING.md))
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete

Show this to the user, then immediately proceed to Step 2. The user reads and thinks while the sub-agents work in parallel.

### 2. Spawn sub-agents

Delegate 3+ radically different interfaces to distinct independent fresh
contexts. The executable local route is three distinct fresh `explorer`
children in one parallel wave. `explorer` is the centrally configured stable
role for one bounded read-only design alternative; the active root driver owns
the briefs, waits, comparison, user dialogue, and final recommendation. This
reference must not create another role, name a model or effort, invent a
provider-specific tool, or bypass central routing.

If the stable `explorer` role or three independent contexts are unavailable,
state that the normal comparison cannot run. As a fallback, produce three
sequential inline alternatives labelled **non-independent**; do not claim that
they provide independent design evidence.

Prompt each independent context with a separate technical brief (file paths, coupling details, dependency category from [DEEPENING.md](./DEEPENING.md), what sits behind the seam). The brief is independent of the user-facing problem-space explanation in Step 1. Give each context a different design constraint:

- Alternative 1: "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- Alternative 2: "Maximise flexibility — support many use cases and extension."
- Alternative 3: "Optimise for the most common caller — make the default case trivial."
- Alternative 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

Include both [SKILL.md](./SKILL.md) vocabulary and `CONTEXT.md` vocabulary in the brief so each context names things consistently with the architecture language and the project's domain language.

Each context outputs:

1. Interface (types, methods, params — plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters (see [DEEPENING.md](./DEEPENING.md))
5. Trade-offs — where leverage is high, where it's thin

### 3. Present and compare

The active root driver presents designs sequentially so the user can absorb each one, then compares them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**.

After comparing, the active root driver gives its own recommendation: which design is strongest and why. If elements from different designs would combine well, it proposes a hybrid. Be opinionated — the user wants a strong read, not a menu.
