---
name: code-review
description: Direct Review entrypoint for a settled diff. Substantial changes receive distinct fresh Spec and Standards reviewers in parallel.
---

# Review

Review the settled change against two independent questions:

- **Spec:** does it implement the authorized request, issue, or Parent PRD
  completely and without scope drift?
- **Standards:** is it correct, maintainable, consistent with repository policy,
  and free of legacy paths, duplicate ownership, compatibility residue, or
  unnecessary machinery?

## Applicability

Review is required when behavior or contract goes beyond an obvious local edit,
including public API, persistence, auth/payment, concurrency/shared state, and
cross-module interaction. Docs, copy, formatting, mechanical config, and an
obvious local correction may complete with direct proof unless the user asks
for Review explicitly.

## Process

1. Pin the settled target: the supplied fixed point or the current isolated
   uncommitted diff. Record changed files, authority, repository policy, and
   proof already completed.
2. Launch exactly two distinct fresh children in one parallel wave:
   - `spec_reviewer` receives the target, authority, changed files, proof, and
     the complete relevant request/issue/Parent PRD;
   - `standards_reviewer` receives the same target plus repository policy and a
     brief to trace correctness, failure paths, cleanup, zero legacy, duplicate
     ownership, and unnecessary scripts.
   Begin each brief with its exact stable role line: `Assigned role:
   spec_reviewer` or `Assigned role: standards_reviewer`.
3. Capture both non-empty child identities and wait for those same children.
   A timeout, failed child, missing identity, or incomplete wait blocks approval.
   Root never substitutes self-review.
4. Verify every concrete finding against the diff and its trigger path. Root or
   Implement applies only in-scope repairs, reruns affected proof, and reviews
   the new settled substantial result with a new parallel pair.
5. Approval requires both completed reviewers to return `APPROVE` for the same
   target and no required proof gap. A finding, failure, timeout, or non-approval
   blocks Review. Review itself does not stage, commit, push, or open a PR.

## Reviewer Output

Each reviewer returns findings first with file/line, concrete trigger or missing
obligation, impact, and evidence. If there are no findings or verification gaps,
it ends with `APPROVE`. Otherwise it ends with `BLOCK` and the concrete reason.

The coordinator returns both axes, repaired or remaining findings, proof gaps,
and `APPROVE` only when both axes approve. Do not create durable review state,
maps, ledgers, aliases, adapters, or compatibility routes.
