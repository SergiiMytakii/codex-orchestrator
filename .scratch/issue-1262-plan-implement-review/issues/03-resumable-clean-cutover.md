# 03 — Resume incomplete Runs and prove the clean lifecycle cutover

## Parent

https://github.com/SergiiMytakii/codex-orchestrator/issues/1262

## Observable outcome

Temporary process, tooling, observation, report-format, and infrastructure failures remain bounded, issue-local, and resumable from the existing Run facts, while final code/docs/proof demonstrate a net deletion clean cutover with no duplicate process or external effect.

## Scope

- In scope: operation-neutral ActiveAttempt recovery, existing PendingEffect observation/settlement, transient-versus-semantic terminal projection, daemon issue isolation, final exact-schema verification after the preceding state changes, public lifecycle/ADR updates, structural deletion proof, and the final package gate.
- Out of scope: durable retry scheduler/counters, queue/cache, new lifecycle/store/coordinator, compatibility reader or migration runtime, weakened safety, live scratch smoke without separate authority, release, production daemon rollout, and consumer updates.

## Acceptance criteria

- [ ] Transport, timeout, launch, observation, malformed report, check tooling, GitHub observation, device unavailability, and bounded local-attempt exhaustion return resumable issue-local outcomes without semantic budget consumption or terminal `exhausted`.
- [ ] One CLI call or daemon tick performs bounded work and releases ownership; an incomplete or Safe-halted Issue does not prevent discovery or processing of other frozen candidates.
- [ ] Before any replacement launch, the Runner adopts the exact attempt-owned result or positively proves the previous process/result absent; live or uncertain ownership permits observation only.
- [ ] An uncertain external effect retains the existing `PendingEffect` and retries only observation/reconciliation; no duplicate process, Git, or GitHub effect is produced.
- [ ] Genuine Decision Delta, out-of-scope work, dirty ownership conflict, proven authority divergence, containment violation, failed required proof, and explicitly unresolvable external blockers remain distinct fail-closed boundaries.
- [ ] Final exact-schema verification proves one Run progression owner, at most one `ActiveAttempt`, and at most one `PendingEffect`; no legacy reader, dual-write, fallback route, compatibility alias, generic transition framework, or new coordinator remains.
- [ ] README, CONTEXT, accepted ADRs, generated/public workflow contracts, and tests describe the implemented Plan → Implement → Review-compatible lifecycle; historical decisions are superseded explicitly, not silently rewritten.
- [ ] Before/after owner and production inventory proves net deletion of obsolete route/spec/full-review/budget mechanics and challenges every added production mechanism against an existing owner.
- [ ] Final local gate passes workflow verification, typecheck, affected and full tests, and `npm pack --dry-run --json` from a clean package materialization. Live scratch smoke and release remain unperformed without separate authority.

## Owner and proof seam

- Owner / public seam: `ActiveAttempt`, recovery-related Run persistence/projection and final exact-schema verification, `PendingEffect` settlement, daemon-to-`RunIssue.runIssue` boundary, package public docs/contracts, and package scripts.
- Proof: first-RED fault injection across every durable launch/result/effect boundary and a multi-candidate daemon scenario; exact effect/process counts; unsupported-state and no-compatibility assertions; owner/symbol/LOC deletion inventory; final `npm run verify:workflow`, `npm run typecheck`, focused/full tests, and clean package dry-run.
- Why false behavior cannot pass: persisted restart tests and effect counters expose semantic spending, duplicate launches/effects, loop retention, or unsafe relaunch, while structural inventory and clean package gates expose surviving legacy owners or stale public contracts.

## Blocked by

[#1264 — Use one targeted repair loop without numeric semantic exhaustion](https://github.com/SergiiMytakii/codex-orchestrator/issues/1264).

## Final state

AFK: `ready-for-agent`. State does not authorize implementation.
