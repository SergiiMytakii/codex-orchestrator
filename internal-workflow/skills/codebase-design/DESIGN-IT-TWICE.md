# Design It Twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, use this parallel sub-agent pattern.

Uses the vocabulary in [SKILL.md](./SKILL.md) — `module`, `interface`, `seam`, `adapter`, `leverage`.

Run this workflow only when the candidate is selected, its constraints are known, and the interface decision is consequential enough to justify independent alternatives. Do not run it for a vocabulary question, one bounded recommendation, or routine helper extraction.

This file defines the comparison protocol; the active root driver executes it and retains session ownership, user dialogue, delegation, and the final decision.

## Process

### 1. Frame the problem space

The active root driver writes a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete

Show this to the user, then immediately proceed to Step 2. The user reads and thinks while the sub-agents work in parallel.

### 2. Spawn sub-agents

Delegate 3+ radically different interfaces to isolated subagent contexts using the exact named role selected by local coding-skill routing. Run them in parallel when supported. This shared reference must not invent a provider-specific tool or override the configured role, model, or effort.

If independent subagents are unavailable, state that the normal comparison cannot run. As a fallback, produce three sequential inline alternatives labelled **non-independent**; do not claim that they provide independent design evidence.

Prompt each sub-agent with a separate technical brief and a different design constraint:

- Agent 1: minimize the interface
- Agent 2: maximize flexibility
- Agent 3: optimize for the most common caller
- Agent 4 (if applicable): design around ports & adapters for cross-seam dependencies

Include both [SKILL.md](./SKILL.md) vocabulary and `CONTEXT.md` vocabulary in the brief so each sub-agent names things consistently.

Each sub-agent outputs:

1. Interface
2. Usage example
3. What the implementation hides behind the seam
4. Dependency strategy and adapters
5. Trade-offs

### 3. Present and compare

The active root driver presents designs sequentially so the user can absorb each one, then compares them in prose. Contrast by depth, locality, and seam placement.

After comparing, give your own recommendation. If elements from different designs would combine well, propose a hybrid.
