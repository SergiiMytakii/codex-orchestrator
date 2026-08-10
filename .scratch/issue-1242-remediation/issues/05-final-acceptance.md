## Parent

#1242

## Source authority

- Source: complete #1242 body, approved remediation Fix Brief, and all preceding graph tickets
- Inherited acceptance IDs: A-009, A-010, A-011, A-012, A-014, A-018, plus final reconciliation of A-001 through A-017
- Linked Contract IDs: all graph Contract IDs
- Implementation preparation: direct; no implementation spec.

## Observable outcome

One immutable final HEAD is independently approved against every #1242 obligation, with fresh owner/LOC metrics, documentation/generated consistency, full required proof, packed scratch-only smoke when preflight succeeds, and strict cleanup.

## Acceptance criteria

- [ ] Perform cumulative code-first review of the complete baseline-to-HEAD production path against every #1242 obligation and Contract ID.
- [ ] Repair only source-authorized defects; return exact Decision Delta for any new product decision.
- [ ] Repeat cumulative review until Approved, then freeze the exact 40-character HEAD.
- [ ] Create a fresh detached temporary Git materialization directly from that commit; no original-checkout bytes are final evidence.
- [ ] Before execution, prove HEAD, index, tracked tree and worktree equal the frozen commit and that no untracked input can influence source, generated contracts, build, tests, package, proof, metrics, or smoke.
- [ ] Create dependencies and outputs only inside that materialization from the committed lockfile and isolated output roots.
- [ ] Bind every final check, contract/fault proof, package/pack result, LOC metric, smoke artifact, and cleanup report to the frozen SHA and Contract IDs.
- [ ] Any source/review/check repair or workspace drift invalidates affected rows and restarts review → freeze → final proof.
- [ ] Final owner map proves one Run, at most one `ActiveAttempt`, and at most one `PendingEffect`, with no parallel lifecycle owners.
- [ ] Production inventory proves no Closure, qualification, waiting workflow, mode-driven recovery, compatibility/migration, workflow engine, queue, cache, retry coordinator, or plan interpreter.
- [ ] README, CONTEXT, current ADR/public lifecycle documentation, and generated contracts match production code. Do not read or edit `docs/deep-dive.md`.
- [ ] Final tracked `src/v2/**/*.ts` physical LOC and tracked `src/v2/run-issue.ts` LOC are strictly below immutable B0 `7b2a002`: 22,704 and 4,142. Record exact tracked path list, commands, SHA, and output; untracked/ignored files never enter the denominator.
- [ ] After final proof and strict cleanup, verify source/index still equal frozen HEAD and no non-isolated input appeared.
- [ ] Controlled packed live smoke is allowed only in the configured scratch GitHub repository after authenticated and exclusive preflight; production-repository smoke is forbidden.
- [ ] Preflight/proof unavailability or Decision Delta produces an exact blocked terminal packet; proof is never weakened or skipped to claim completion.

## Owner and proof seam

- Owner / public seam: final production bytes, Parent Acceptance Map, Contract Test Ledger, changed-owner inventory, docs/generated contracts, pack and live-smoke harness.
- Material consumers: parent #1242 acceptance and package maintainers.
- First proof: cumulative adversarial review, exact clean-materialization gate, fresh owner/LOC inventory, all final Contract rows, pack, authorized scratch scenarios, strict cleanup.
- Proof compatibility: only evidence from the frozen clean materialization is final evidence.

## Invalidation

- Invalidates: every stale earlier proof row when shared owners/seams changed.
- Invalidated by: any code/source/generated-contract change after freeze; restart cumulative review and reproof.
- Final review contribution: the only terminal approval gate for #1242.

## External contracts

Status: needs proof at execution.

- Configured scratch GitHub repository, authenticated current identity, exclusive candidate ownership, strict cleanup.
- Production repository is forbidden.

## Verification

- Automated: required final affected/full checks and complete contract/fault matrix at frozen SHA.
- Architecture: complete owner map and forbidden-mechanism inventory.
- Manual/live: packed scratch-only scenarios after preflight; strict cleanup.

## Risk / Review

- Primary risk: stale or dirty-workspace evidence approving bytes other than final HEAD.
- Main invariant: all acceptance evidence refers to one immutable clean materialization.
- Review focus: structural deletion, proof freshness, authority/containment, exact publication, no new orchestration.

## Blocked by

#1259

## Out of scope / rejected approaches

- Release, remote code push, consumer update, production daemon restart, production smoke, automatic merge, human approval automation, or scope expansion.
- No production mechanism may be added solely to produce evidence.

## Final state

AFK: `ready-for-agent`. It may complete or return an exact blocked/Decision Delta outcome. State does not authorize implementation.
