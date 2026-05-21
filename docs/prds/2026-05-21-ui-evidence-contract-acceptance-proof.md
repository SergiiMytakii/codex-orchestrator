# PRD: UI Evidence Contract for Acceptance Proof

## Problem Statement

Acceptance Proof currently validates that a Proof Report has high-confidence criteria and linked artifacts, but it does not strictly prove that UI artifacts show the exact user workflow, current screen state, visual layout quality, or user-facing copy required by the issue.

This lets an Adaptive Proof Agent produce weak proof: a screenshot can exist, but it may come from the wrong flow, the wrong viewport, an old artifact, or a nearby UI state that does not demonstrate the requested behavior. In the failure case that triggered this PRD, proof drifted from the create campaign flow into nearby screens, over-relied on narrow/mobile evidence, missed obvious desktop padding defects, used rejected technical copy, and showed stale/intermediate screenshots after later proof runs.

The user-facing problem is simple: a Draft PR Handoff can look "proven" even when the UI proof does not actually prove what the user asked for.

## Solution

Add a runner-enforced UI Evidence Contract inside the Proof Report. UI proof should not pass merely because a screenshot or UI dump exists. When Acceptance Proof uses UI artifacts, the Proof Report must map those artifacts to the exact workflow, relevant viewport coverage, current artifact freshness, visual layout review, and user-facing copy review.

The Adaptive Proof Agent remains responsible for deriving task-specific UI checks from the issue acceptance criteria during proof. The Runner remains responsible for validating that the report contains a complete UI Evidence Contract before allowing Draft PR Handoff. Screenshot-only command success should be removed as a pass path, not retained as a compatibility fallback.

The design should incorporate the useful parts of Symphony's visual proof workflow discipline without copying its weaker enforcement model. Symphony asks agents to add UI walkthrough acceptance criteria for user-facing changes, capture a reproduction signal before implementation, run app/runtime validation, upload media, and use a Manual QA Plan to sharpen coverage. Codex Orchestrator should preserve those ideas but enforce them through the runner-validated Proof Report.

## User Stories

1. As a maintainer, I want UI proof to show the exact user workflow requested by the issue, so that nearby screens do not pass as evidence.
2. As a maintainer, I want create-flow proof to be distinguished from edit-flow proof, so that the wrong product context cannot satisfy acceptance criteria.
3. As a maintainer, I want screenshots to be mapped to acceptance criteria, so that a screenshot file alone is not treated as proof.
4. As a maintainer, I want UI proof to record the entrypoint used to reach the screen, so that direct state setup does not hide broken user navigation.
5. As a maintainer, I want UI proof to use real UI login when configured credentials exist, so that proof follows the user path unless there is a concrete blocker.
6. As a maintainer, I want session or cookie seeding to be explained when used, so that shortcuts are visible and reviewable.
7. As a maintainer, I want wide desktop proof for web layout changes, so that desktop spacing defects are not missed by mobile-only screenshots.
8. As a maintainer, I want mobile proof only when mobile or responsive behavior is relevant, so that UI proof stays focused and not unnecessarily flaky.
9. As a maintainer, I want viewport dimensions recorded in proof, so that reviewers know what layout state was checked.
10. As a maintainer, I want the current post-run artifact identified, so that old or intermediate screenshots are not shown as final proof.
11. As a maintainer, I want artifact freshness to be explicit, so that overwritten screenshot paths do not create confusion.
12. As a maintainer, I want UI proof to review spacing and padding, so that cramped or edge-touching layouts do not pass.
13. As a maintainer, I want UI proof to review overlap and clipping, so that hidden or unreadable controls do not pass.
14. As a maintainer, I want UI proof to review alignment and responsive placement, so that controls appear in the intended relationship to neighboring fields.
15. As a maintainer, I want UI proof to check the specific visual complaint from the issue, so that generic geometry checks do not miss the real defect.
16. As a maintainer, I want user-facing copy reviewed during UI proof, so that implementation terms are not exposed to users.
17. As a maintainer, I want rejected terms to be recorded as absent when copy was part of the issue, so that technical wording does not silently return.
18. As a maintainer, I want the Adaptive Proof Agent to derive task-specific UI checks from acceptance criteria, so that every UI task gets relevant verification without hardcoding product-specific rules into the Runner.
19. As a maintainer, I want the Runner to block shallow UI proof, so that weak agent reasoning cannot bypass the review gate.
20. As a maintainer, I want missing or ambiguous UI criteria to become needs-rework or blocked proof, so that unclear acceptance criteria do not become false passes.
21. As a reviewer, I want Draft PR Handoff evidence to explain why each screenshot proves the issue, so that review can focus on product quality rather than reconstructing proof context.
22. As a reviewer, I want proof reports to identify exact screen state, so that I can tell whether the proof was for a new entity, existing entity, detail view, modal, or settings panel.
23. As a reviewer, I want proof artifacts to include enough layout context, so that cropped or partial screenshots cannot hide surrounding defects.
24. As a reviewer, I want final proof artifacts to be distinguishable from earlier attempts, so that comments and handoff reports do not point at stale UI.
25. As an Adaptive Proof Agent, I want a clear UI Evidence Contract schema, so that I know what must be reported for UI proof to pass.
26. As an Adaptive Proof Agent, I want prompts to require workflow, viewport, freshness, layout, and copy evidence, so that I do not accidentally submit screenshot-only proof.
27. As an Adaptive Proof Agent, I want proof shortcuts to be reportable as residual risk or blocker evidence, so that I can proceed safely when normal UI login is impossible.
28. As a Runner, I want a simple report validator for UI proof completeness, so that proof quality is enforceable without understanding every product domain.
29. As a Runner, I want screenshot-only fallback removed, so that Acceptance Proof cannot pass without a machine-readable proof report.
30. As a Runner, I want legacy visual-proof configuration treated as migration input, so that old settings can still point to proof commands without weakening Acceptance Proof.
31. As a repository owner, I want the canonical contract to stay under Acceptance Proof, so that visual proof remains a variant rather than a separate source of truth.
32. As a repository owner, I want UI proof failures to produce actionable rework requests, so that implementation agents know what to fix next.
33. As a repository owner, I want proof agent prompts updated with the new contract, so that downstream repositories receive the stronger behavior through setup.
34. As a repository owner, I want tests around the report validator, so that future prompt changes cannot weaken proof quality unnoticed.
35. As a repository owner, I want the failure mode from the IntelliOutreach proof case covered, so that a screenshot with no workflow scope or visual analysis cannot pass again.
36. As a maintainer, I want user-facing work to produce a UI walkthrough acceptance criterion, so that proof starts from an explicit end-to-end path.
37. As a maintainer, I want proof to preserve the original reproduction signal when available, so that the final evidence can be compared against the behavior that motivated the fix.
38. As a maintainer, I want app-touching changes to include runtime validation and media artifacts, so that UI proof shows the product running rather than only static assertions.
39. As a maintainer, I want an existing Manual QA Plan to sharpen the UI Evidence Contract, so that human-written validation expectations are not ignored.
40. As a maintainer, I want Symphony-style proof discipline encoded as runner-validated evidence, so that it cannot degrade into optional checklist prose.

## Implementation Decisions

- Add UI Evidence Contract as a structured section of the Proof Report, not as a separate product-specific script contract.
- Treat scripts, harnesses, Playwright checks, browser sessions, UI dumps, and screenshots as evidence producers. The Proof Report remains the Runner-validated source of truth.
- Require UI Evidence Contract when a Proof Report includes screenshot or UI-dump artifacts, or when Acceptance Proof is triggered by UI/layout/frontend work.
- The UI Evidence Contract must cover exact workflow scope, viewport coverage, current artifact freshness, visual layout review, and user-facing copy review.
- The Adaptive Proof Agent derives concrete task-specific checks from the issue acceptance criteria during proof. The Runner validates the structure and completeness of that mapping.
- For web layout proof, wide desktop coverage is required. Mobile coverage is required only when mobile or responsive behavior is part of the issue or acceptance criteria.
- If authentication is required and configured smoke/admin credentials exist, UI proof should use the real sign-in flow. Session or cookie seeding is allowed only with an explicit reason in the Proof Report.
- Remove screenshot-only pass fallback completely. A visual proof command that produces screenshots but no valid machine-readable Proof Report must not pass Acceptance Proof.
- Preserve `visualProof` only as a migration adapter for existing configuration, not as a weaker pass path.
- Keep non-visual Live Smoke Proof on the existing Acceptance Proof model; do not require UI Evidence Contract for pure API, worker, CLI, or smoke-output-only proof.
- Keep product-specific layout semantics out of Runner code. The Runner should validate that task-specific checks exist and are mapped to artifacts, while the Adaptive Proof Agent writes the checks.
- Borrow Symphony's workflow discipline as proof input: user-facing changes should produce a UI walkthrough acceptance criterion, pre-change reproduction signal, runtime validation/media evidence for app-touching work, and Manual QA Plan incorporation when such a plan exists.
- Do not copy Symphony's enforcement boundary directly. In Symphony, much of this proof discipline lives in workflow prompt and workpad process; in Codex Orchestrator, the Runner should validate the Proof Report and block shallow proof.
- The Adaptive Proof Agent should record how the task-specific UI checks were derived: issue acceptance criteria, implementation evidence, reproduction signal, and any Manual QA Plan or validation section.
- Runtime validation and media requirements should become evidence inputs to the UI Evidence Contract, not separate publication authority for the Adaptive Proof Agent.
- Implemented decision-rich shape for the report extension:

```ts
type UiEvidenceFailureDimension =
  | 'workflow'
  | 'viewport'
  | 'freshness'
  | 'layout'
  | 'copy'
  | 'source-input';

uiEvidence?: {
  workflowScope: {
    entrypoint: string;
    path: string[];
    screenState: string;
    authPath?: 'real-login' | 'seeded-session' | 'not-required' | 'blocked';
    authShortcutReason?: string;
  };
  viewportCoverage: Array<{
    name: string;
    width: number;
    height: number;
    artifactRefs: string[];
    requiredBy: 'desktop-web-layout' | 'mobile-or-responsive' | 'issue-specific' | 'other';
  }>;
  artifactFreshness: {
    currentArtifactRefs: string[];
    checkedAfterFinalRun: boolean;
  };
  layoutReview: {
    checked: boolean;
    findings: Array<{ summary: string; artifactRefs: string[] }>;
  };
  copyReview: {
    checked: boolean;
    acceptedTerms?: string[];
    rejectedTermsAbsent?: string[];
    findings: Array<{ summary: string; artifactRefs: string[] }>;
  };
  sourceInputs: {
    acceptanceCriteriaRefs: string[];
    implementationEvidenceRefs: string[];
    reproductionSignalRefs?: string[];
    manualQaPlanRefs?: string[];
    runtimeValidationRefs?: string[];
  };
}
```

Every UI Evidence failure must use the stable runner reason format
`UI Evidence <dimension>:` with the dimensions listed above.

## Testing Decisions

- Tests should verify external Runner behavior through the Acceptance Proof evaluation surface, not private implementation details.
- Add report validation tests proving UI screenshot proof is rejected when workflow scope is missing.
- Add report validation tests proving UI screenshot proof is rejected when visual layout review is missing.
- Add report validation tests proving UI screenshot proof is rejected when copy review is missing for UI proof.
- Add report validation tests proving UI screenshot proof is rejected when current artifact freshness is missing or false.
- Add report validation tests proving a complete UI Evidence Contract passes when criteria, artifacts, and proof-phase diff are otherwise valid.
- Add runner visual proof tests proving screenshot artifacts without a valid machine-readable Proof Report do not pass.
- Add prompt-generation tests proving the Adaptive Proof Agent contract asks for workflow, viewport, freshness, layout, and copy evidence.
- Add regression coverage for the known bad proof shape: "A screenshot exists" plus high confidence must not pass.
- Add prompt-generation tests proving the Adaptive Proof Agent must derive task-specific UI checks from acceptance criteria, reproduction signals, implementation evidence, and Manual QA Plan content when present.
- Add validation tests proving source inputs can be referenced by artifact path, report evidence, or issue/workpad text, but cannot replace workflow, viewport, freshness, layout, and copy review.
- Prior art includes existing Acceptance Proof policy tests, visual proof runner tests, scoped auto command tests, and prompt builder tests.

## Out of Scope

- Building a universal pixel-perfect visual diff engine.
- Hardcoding product-specific IntelliOutreach criteria into Codex Orchestrator.
- Requiring mobile proof for every web UI change.
- Requiring UI Evidence Contract for pure non-visual proof.
- Giving the Adaptive Proof Agent GitHub write authority.
- Allowing proof-phase product-code fixes.
- Publishing or applying autonomous execution labels as part of this PRD.
- Replacing human review; the goal is stronger evidence for Draft PR Handoff, not automatic merge approval.
- Implementing Symphony's Linear workpad model or PR media workflow directly.

## Further Notes

This PRD follows the existing domain model: Acceptance Proof is the canonical runner-owned review gate, Proof Report is the structured source of truth, Proof Artifacts are persisted evidence files, and Adaptive Proof Agent is a proof-phase verifier rather than an implementation owner.

The motivating failure case came from a UI proof where the agent initially showed or generated screenshots that did not prove the requested create-flow behavior, missed desktop layout defects, used rejected technical copy, and confused final artifacts with earlier proof output. The desired fix is to make that class of proof impossible to pass through Runner validation.

Symphony's public workflow provides useful prior art: user-facing changes should include a UI walkthrough acceptance criterion, proof should start from a concrete reproduction signal, app-touching changes should run app validation and attach media, and Manual QA Plan content should influence runtime/UI coverage. The difference is that Codex Orchestrator should make those ideas machine-checkable through Acceptance Proof rather than relying only on agent workpad discipline.
