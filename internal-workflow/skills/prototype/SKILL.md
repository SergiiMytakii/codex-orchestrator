---
name: prototype
description: Build bounded throwaway code to answer one logic, state-model, or UI design question before production implementation.
---

# Prototype

A prototype is throwaway code that answers one explicit design question. It is
a side primitive, not a production implementation route or planning owner.

## Choose the question

- For logic, state transitions, or data shape, follow [LOGIC.md](LOGIC.md). Build
  a tiny interactive terminal app that pushes the state model through cases
  that are hard to reason about on paper and exposes the complete relevant
  state after each action.
- For UI, follow [UI.md](UI.md). Build up to three structurally different
  variants in the existing application context and make switching between them
  obvious and reversible.

If the branch is genuinely ambiguous and repository evidence does not resolve
it, ask which question the prototype must answer before writing code.

## Boundaries

1. **Throwaway from day one, and clearly marked as such.** Keep artifacts out
   of production paths unless the repository already has an explicit prototype
   convention. Locate them close enough to the target module or page that the
   context stays obvious, without turning them into production implementation.
2. Use the host repository's existing language, task runner, routing, and UI
   system. Add no new framework, persistence layer, or infrastructure.
3. **No persistence by default.** State lives in memory. If persistence itself
   is the question, use an isolated scratch store. Use no real production
   mutations, production credentials, or production data.
4. Provide one deterministic command or URL that lets the user exercise the
   question directly. Skip production polish, abstractions, broad tests, and
   unrelated error handling.
5. **Surface the state.** After every action (logic) or every variant switch
   (UI), print or render the full relevant state so the user can see what
   changed.
6. **Preserve primary-source provenance before cleanup.** Create a
   self-contained reproduction bundle under
   `${CODEX_HOME:-$HOME/.codex}/artifacts/prototypes/<timestamp>-<slug>/`,
   outside the production tree. Copy the exact prototype source, inputs and
   fixtures, deterministic command or URL, observed output or screenshots,
   answer to the design question, and content digests for every bundled file.
   Its manifest records the host repository identity, exact host Git revision,
   dirty host file digests when the prototype depended on uncommitted context,
   runtime and toolchain versions, dependency manifests and lockfiles, and the
   required host-file set. Every dirty tracked dependency must be recoverable
   from a complete bundled patch relative to the recorded revision, and every
   untracked dependency must be preserved as exact bundled bytes at its relative
   path. A path or digest alone is never sufficient. If required bytes contain
   secrets or production data and cannot be replaced by an equivalent safe
   fixture, the bundle is not self-contained and cleanup must stop. UI
   auth, data, routing, and shell dependencies must be represented by bundled
   read-only fixtures or stubs, never credentials. Include setup instructions
   that restore the bundle in an isolated worktree at the recorded revision and
   prove every digest before running the command or URL. Use relative paths
   inside the bundle and include no secrets or production data. Return the
   bundle path to the user so the experiment can be rerun after cleanup.
7. Record the answer separately from the throwaway code, then remove it from
   production paths or leave it only in the repository's explicit prototype
   area. The reproduction bundle remains the primary source. Production
   delivery returns to `$implement` and receives its normal proof and Review;
   do not promote prototype code directly.

Prototype creates no Git action. Branches, commits, push, PR, and tracker
writes require their own authority and remain owned by root.
