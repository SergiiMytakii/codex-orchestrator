---
name: prototype
description: Build bounded throwaway code to answer one logic, state-model, or UI design question before production implementation.
---

# Prototype

A prototype is throwaway code that answers one explicit design question. It is
a side primitive, not a production implementation route or planning owner.

## Choose the question

- For logic, state transitions, or data shape, build the smallest interactive
  harness that exposes the complete relevant state after each action.
- For UI, build up to three structurally different variants in the existing
  application context and make switching between them obvious and reversible.

If the branch is genuinely ambiguous and repository evidence does not resolve
it, ask which question the prototype must answer before writing code.

## Boundaries

1. Mark every artifact clearly as a prototype and keep it out of production
   paths unless the repository already has an explicit prototype convention.
2. Use the host repository's existing language, task runner, routing, and UI
   system. Add no new framework, persistence layer, or infrastructure.
3. Keep state in memory unless persistence itself is the question. Use no real
   production mutations.
4. Provide one deterministic command or URL that lets the user exercise the
   question directly. Skip production polish, abstractions, and broad tests.
5. Record the answer separately from the throwaway code. Production delivery
   returns to `$implement` and receives its normal proof and Review.

Prototype creates no Git action. Branches, commits, push, PR, and tracker
writes require their own authority and remain owned by root.
