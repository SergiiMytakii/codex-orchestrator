---
name: grilling
description: Grill the user about a plan, decision, or idea through dependency-aware frontier rounds. Use when the user wants to stress-test their thinking or uses a grill trigger phrase.
---

# Grilling

Interview the user until you reach a shared understanding. Model the subject as
a **design tree**: each material decision branches into the decisions that
depend on it.

Root owns every user-facing question, recommendation, wait for feedback, and
accepted decision. Never delegate or impersonate the dialogue. A bounded
`explorer` may gather read-only evidence when a fact depends on a cross-module
path; it returns evidence to root and makes no product decision.

## Frontier rounds

The **frontier** is every unresolved material decision whose prerequisites are
settled. Ask the whole frontier in one numbered round. For each question:

- state the decision and enough context to answer it;
- give two or three concrete options when multiple paths are plausible;
- mark one recommended answer and explain the trade-off briefly;
- say plainly when evidence leaves only one valid option.

Then wait for the user's answers. Each answer reshapes the design tree: record
the settled decision, recompute the frontier, and ask the next numbered round.
A question whose answer depends on a decision still open in the current round
belongs to a later round. Do not ask it early or guess its prerequisite.

Finding facts is the agent's job, never the user's. Look up facts in the
environment, codebase, current docs, or authorized external sources. If a fact
lookup is still running, treat it as an unsettled prerequisite: defer only its
downstream questions and ask the rest of the current frontier now. The
decisions remain the user's; put every material decision to them and use their
answers to resolve only minor follow-ons.

The interview is complete only when the frontier is empty: every material
branch is settled or explicitly ruled out and no decision is silently assumed.
Summarize the resulting shared understanding and ask the user to confirm it.
Do not act on the result until the user explicitly confirms the shared
understanding. A product plan produced here is input to the active driver; this
skill does not implement it.

## Mutation boundary

Grilling is write-free. It may read repository domain language to phrase
questions consistently, but it never creates or edits `CONTEXT.md`,
`CONTEXT-MAP.md`, or ADRs. Domain-document mutation belongs only to
`$domain-modeling`, when that discipline is separately active.
