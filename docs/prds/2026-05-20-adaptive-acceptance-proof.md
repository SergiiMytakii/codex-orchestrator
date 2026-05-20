# PRD: Adaptive Acceptance Proof

Issue tracker status: local PRD draft. GitHub Issue publication and `needs-triage` labeling are intentionally not performed from this agent session because this repository's policy keeps GitHub issue mutation inside runner-owned code paths.

## Problem Statement

Codex Orchestrator can require runner-owned visual proof, but deterministic proof commands are too brittle for real product verification. Browser, Android, mobile, API, worker, and CLI flows often need adaptive navigation, retries, UI inspection, log review, or live smoke checks before acceptance criteria can be confidently proven.

Today, when a proof script cannot navigate the app or a mobile environment behaves differently than expected, the proof phase can fail without enough useful diagnosis. At the same time, letting the implementation Agent own proof, labels, or publication would violate the Runner-Owned Publication Boundary and make proof results harder to audit.

## Solution

Add always-adaptive Acceptance Proof as a runner-owned review gate. The Runner will run an Adaptive Proof Agent after implementation or rework, give it proof-phase tools, collect a structured Proof Report and Proof Artifacts, validate proof-phase changes, and decide whether the issue is ready for Draft PR Handoff or needs another implementation iteration.

Acceptance Proof should cover both visual and non-visual criteria. For UI work, the Adaptive Proof Agent should navigate the running app, inspect screenshots or UI trees, and explain with high confidence how the artifacts prove the acceptance criteria. For non-visual work, it should be able to create and run a Live Smoke Proof that exercises observable product behavior and maps the result back to the acceptance criteria.

The loop remains runner-owned. The issue stays claimed while iterations continue. The Runner changes labels only at terminal states: review-ready when proof passes, or blocked when the configured iteration limit is exhausted.

## User Stories

1. As a maintainer, I want proof to adapt when UI navigation changes, so that valid work is not blocked by brittle scripts.
2. As a maintainer, I want proof to remain runner-owned, so that an agent cannot bypass publication or issue-state policy.
3. As a maintainer, I want proof results to include artifacts and analysis, so that I can understand why a draft PR is ready for review.
4. As a maintainer, I want screenshots to be analyzed against acceptance criteria, so that a screenshot alone is not treated as proof.
5. As a maintainer, I want non-visual acceptance criteria to be verified through live smoke checks, so that backend, worker, CLI, and API behavior can be proven.
6. As a maintainer, I want the Adaptive Proof Agent to repair proof scripts only in proof-owned paths, so that validation improvements can happen without hiding product changes.
7. As a maintainer, I want product-code changes from the proof phase to block the proof result, so that implementation remains separate from verification.
8. As a maintainer, I want a bounded Acceptance Proof Loop, so that automation keeps trying useful rework but cannot run forever.
9. As a maintainer, I want the default proof loop limit to be five iterations, so that hard problems get multiple chances without creating runaway automation.
10. As a maintainer, I want the issue to stay running during proof iterations, so that other runners do not pick up the same issue mid-loop.
11. As a maintainer, I want terminal label changes only after the proof loop finishes, so that issue state remains clear and auditable.
12. As a maintainer, I want a Proof Rework Request when proof finds missing product behavior, so that implementation can address a concrete failure.
13. As a maintainer, I want Proof Rework Requests to be applied by the Runner, so that labels and comments remain inside the Runner-Owned Publication Boundary.
14. As a maintainer, I want proof-phase shell access to be useful but bounded by runner validation, so that adaptive proof can diagnose real systems without gaining publication authority.
15. As a maintainer, I want network access available when live product proof needs it, so that real integration behavior can be checked.
16. As a maintainer, I want GitHub write credentials unavailable to proof agents, so that proof cannot mutate issues, labels, comments, branches, or PRs.
17. As a maintainer, I want every required acceptance criterion to be mapped to evidence, so that partial proof does not become a Draft PR Handoff.
18. As a maintainer, I want proof confidence to be explicit, so that low-confidence agent judgments become blockers instead of silent passes.
19. As a maintainer, I want proof artifacts to include screenshots, logs, UI dumps, and smoke outputs where relevant, so that failures are diagnosable.
20. As a maintainer, I want Android proof to use the Test Android Apps workflow, so that mobile QA follows stable adb, UI-tree, screenshot, and logcat practices.
21. As a maintainer, I want Android proof to use the Runner-provided device lease and `ANDROID_SERIAL`, so that parallel issues do not fight over the same emulator.
22. As a maintainer, I want Android tap coordinates derived from UI tree bounds, so that proof navigation is less flaky than screenshot guessing.
23. As a maintainer, I want Android proof to save screenshot, UI dump, and logcat artifacts, so that visual state and runtime failures are reviewable.
24. As a maintainer, I want browser proof to navigate adaptively, so that login, onboarding, delayed rendering, and alternate menus can be handled.
25. As a maintainer, I want live smoke proof to be able to create temporary checks, so that missing repo-owned smoke scripts do not make verification impossible.
26. As a maintainer, I want temporary or repaired proof scripts to be visible in the diff, so that reviewers can see how acceptance was verified.
27. As a maintainer, I want legacy visual proof config to keep working, so that existing repositories are not broken by the broader Acceptance Proof model.
28. As a repository owner, I want `reviewGates.acceptanceProof` to be the canonical policy surface, so that proof no longer means only screenshots.
29. As a repository owner, I want `reviewGates.visualProof` to remain a compatibility adapter, so that migration can be incremental.
30. As a runner operator, I want proof reports to be machine-validated, so that an agent's final text is not enough to pass the gate.
31. As a runner operator, I want proof failures to preserve artifacts, so that blocked issues contain useful recovery evidence.
32. As a runner operator, I want proof attempts to be logged as lifecycle events, so that interrupted or flaky runs can be reconstructed.
33. As an implementation Agent, I want Proof Rework Requests to describe concrete missing behavior, so that rework can target the observed failure.
34. As an Adaptive Proof Agent, I want clear allowed responsibilities, so that I can navigate and analyze the product without changing issue state or publication.
35. As a reviewer, I want draft PRs to include proof summaries and links to artifacts, so that I can quickly judge whether acceptance criteria were met.
36. As a reviewer, I want residual risks from proof to be explicit, so that warnings are not hidden behind a green result.
37. As a project maintainer, I want proof behavior to respect existing deny rules, so that secret files, deploys, destructive actions, and publication remain blocked.
38. As a project maintainer, I want proof script repair paths to be configurable, so that different repo layouts can opt into their own verification directories.
39. As a project maintainer, I want product-code diffs from proof to become blockers, so that proof cannot quietly become a second implementation phase.
40. As a project maintainer, I want the same Acceptance Proof model for scoped issues and child issue waves, so that parent integration remains consistent.

## Implementation Decisions

- Introduce Acceptance Proof as the canonical review-gate concept. Visual proof becomes one variant of Acceptance Proof rather than the umbrella term.
- Add a canonical `reviewGates.acceptanceProof` policy surface. Keep `reviewGates.visualProof` as a backward-compatible adapter for existing repository configs.
- Run Acceptance Proof as an always-adaptive phase after implementation or rework, not only as a fallback after deterministic scripts fail.
- Keep the Runner as the owner of issue state, labels, comments, branch pushes, draft PR creation, leases, timeouts, artifact validation, and final pass/block decisions.
- Add an Adaptive Proof Agent role that can use proof-phase tools to navigate UI, run smoke checks, inspect artifacts, and write a structured Proof Report.
- Allow full local proof-phase shell access, while keeping GitHub write authority and publication unavailable to the proof phase.
- Allow network access when required for live product behavior, controlled by runner policy.
- Permit Proof Script Repair only in configured proof-owned paths.
- Treat any product-code diff produced during proof as a blocking proof failure. Product behavior changes must be routed back through implementation by a Proof Rework Request.
- Define one Acceptance Proof Loop iteration as implementation or rework followed by adaptive proof and a runner decision.
- Use a default maximum of five Acceptance Proof Loop iterations.
- Keep the issue in the running state during loop iterations. Move to review only after proof passes. Move to blocked only after the iteration limit is exhausted or an unrecoverable proof-policy violation occurs.
- Require a machine-readable Proof Report. The report should include criterion-level status, confidence, reasoning summary, linked artifacts, proof script repair summary, proof-phase diff classification, residual risks, and any Proof Rework Request.
- Pass Acceptance Proof only when every required acceptance criterion has `status=passed`, `confidence=high`, at least one linked artifact, and no forbidden proof-phase diff.
- Treat partial proof, low confidence, missing artifacts, missing criterion mapping, or product-code proof diffs as blockers or rework input rather than Draft PR Handoff conditions.
- Support Live Smoke Proof for non-visual acceptance criteria. The Adaptive Proof Agent may create and run a live smoke check when no suitable repo-owned check exists, but the Runner must validate the resulting proof artifacts and diff.
- Require Android Acceptance Proof to use the Test Android Apps workflow. Android proof must use the Runner-provided device lease and `ANDROID_SERIAL`, drive the app with `adb -s`, derive tap coordinates from UI tree bounds, and save screenshot, UI dump, and logcat artifacts.
- Reuse the existing runner-owned mobile lease model for Android proof. The Adaptive Proof Agent must not select, start, or own devices independently of the Runner.
- Preserve durable run evidence for every proof attempt, including prompt, proof report, artifacts, logs, lifecycle events, skipped checks, blockers, and residual risks.
- Apply the same Acceptance Proof model to scoped issue runs and child issue runs inside parent issue-tree execution.

Prototype-level Proof Report shape:

```ts
type ProofReport = {
  status: 'passed' | 'needs-rework' | 'blocked';
  criteria: Array<{
    id: string;
    description: string;
    status: 'passed' | 'failed' | 'unknown';
    confidence: 'high' | 'medium' | 'low';
    reasoningSummary: string;
    artifactRefs: string[];
  }>;
  artifacts: Array<{
    type: 'screenshot' | 'ui-dump' | 'log' | 'smoke-output' | 'other';
    path?: string;
    description: string;
  }>;
  proofScriptRepair?: {
    changedPaths: string[];
    summary: string;
  };
  proofPhaseDiff: {
    allowedProofPaths: string[];
    forbiddenProductPaths: string[];
  };
  reworkRequest?: {
    summary: string;
    requiredChanges: string[];
    evidenceRefs: string[];
  };
  residualRisks: string[];
};
```

## Testing Decisions

- Tests should assert externally visible runner behavior: config migration, state transitions, proof report validation, diff classification, artifact collection, Android contract enforcement, and publication blocking.
- Unit-test the Acceptance Proof policy module as a deep module. It should accept config, issue context, proof report, proof artifacts, and proof-phase diff, then return pass, rework, or blocked.
- Unit-test config parsing and migration from legacy visual proof settings into the canonical Acceptance Proof model.
- Unit-test Proof Report validation with passing reports, partial reports, missing artifacts, low confidence, unknown criteria, and malformed agent output.
- Unit-test proof-phase diff classification with allowlisted proof script repairs, product-code changes, mixed diffs, and untracked files.
- Unit-test Acceptance Proof Loop state behavior: running label retained during iterations, review label only on pass, blocked label only on terminal failure.
- Unit-test Android proof prompt/contract generation to require Test Android Apps, `ANDROID_SERIAL`, `adb -s`, UI tree-derived coordinates, screenshot, UI dump, and logcat.
- Add integration-style runner tests around scoped issue publishability to prove proof failures block Draft PR Handoff and proof passes allow handoff.
- Add integration-style runner tests around child issue execution to prove Acceptance Proof applies consistently inside parent issue-tree waves.
- Existing tests around visual proof runner, Android visual proof command, review gates, prompt builder, config schema, scoped auto command, and plan auto command are the closest prior art.
- Avoid tests that assert internal prompt wording except where wording is the contract. Prefer asserting required contract lines and structured inputs/outputs.
- Do not run live smoke tests by default. Live smoke remains opt-in because it can mutate real GitHub or external systems.

## Out of Scope

- Auto-merging pull requests.
- Giving proof agents GitHub write authority.
- Letting proof agents update labels, comments, branches, pull requests, deployments, or releases directly.
- Allowing proof agents to change product code as part of proof.
- Replacing human review of draft PRs.
- Hosted runner infrastructure.
- Non-GitHub issue trackers.
- Non-Codex agent backends.
- Perfect semantic verification of arbitrary acceptance criteria without artifacts.
- Running real Android emulators or live smoke checks in the default unit test suite.

## Further Notes

- The domain glossary and ADR use Acceptance Proof as the canonical term. Visual proof remains a compatibility concept for existing config and user language.
- The Adaptive Proof Agent is not an implementation Agent. It is a verification operator inside a runner-owned proof phase.
- The Android proof path must use the Test Android Apps workflow because it already defines stable emulator QA practices: adb launch, input, UI tree inspection, screenshots, and logcat capture.
- Publishing this PRD to GitHub with `needs-triage` is intentionally deferred to a runner-owned or maintainer-approved path because this repository forbids direct issue mutation by agents outside runner code paths.
