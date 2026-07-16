---
name: grilling
description: Grill the user about a plan, decision, or idea against codebase evidence and the project's domain model, sharpening terminology and updating CONTEXT.md or ADRs as decisions crystallize. Use when the user wants to stress-test their thinking or uses any 'grill' trigger phrase.
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

<what-to-do>

Interview me until we reach a shared understanding. Walk down the decision tree in dependency order, resolving the decisions that other decisions depend on first. For each question, provide your recommended answer.

Ask one high-leverage question at a time and wait for feedback before continuing. Prioritize questions where you genuinely need the user's judgment. Do not ask questions just to be exhaustive.

For each question, provide 2-3 concrete answer options when more than one path is plausible. Mark one option as **Recommended** and explain why it is the best trade-off. If evidence proves there is only one valid option, say that plainly instead of inventing alternatives.

If a fact can be found by exploring the environment, codebase, or existing docs, look it up rather than asking. The decisions are the user's: put each material decision to them and wait for an answer. Use each answer and the evidence to resolve minor follow-on details yourself.

Do not act on the plan or design until the user confirms that shared understanding has been reached.

</what-to-do>

<supporting-info>

## Domain awareness

During codebase exploration, also look for existing documentation.

### File structure

Most repos have a single context:

```text
/
|-- CONTEXT.md
|-- docs/
|   `-- adr/
|       |-- 0001-event-sourced-orders.md
|       `-- 0002-postgres-for-write-model.md
`-- src/
```

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives:

```text
/
|-- CONTEXT-MAP.md
|-- docs/
|   `-- adr/                         <- system-wide decisions
`-- src/
    |-- ordering/
    |   |-- CONTEXT.md
    |   `-- docs/adr/                <- context-specific decisions
    `-- billing/
        |-- CONTEXT.md
        `-- docs/adr/
```

Create files lazily, only when there is something to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. For example: "Your glossary defines cancellation as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. For example: "You're saying account. Do you mean the Customer or the User? Those are different concepts."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force precise boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. Surface contradictions instead of silently choosing one version.

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` immediately. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

Do not couple `CONTEXT.md` to implementation details. Include only terms meaningful to domain experts.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** - changing the decision later has a meaningful cost.
2. **Surprising without context** - a future reader will wonder why this choice was made.
3. **The result of a real trade-off** - genuine alternatives existed and one was chosen for specific reasons.

If any condition is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

</supporting-info>
