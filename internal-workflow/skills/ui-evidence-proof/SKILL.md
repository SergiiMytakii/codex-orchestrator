---
name: ui-evidence-proof
description: Prove UI, layout, copy, responsive, browser, mobile, or frontend changes with fresh visual artifacts. Use when app-facing completion requires workflow/viewport evidence and criterion-to-artifact mapping.
---

# UI Evidence Proof

Use this skill when the task needs visual proof in normal Codex app chat. It is a prompt-level proof workflow, not the package runner's machine-enforced Acceptance Proof. The goal is to stop "some screenshot exists" from becoming "the UI is proven."

## Activation

Use this skill for:

- explicit requests for visual proof, UI proof, screenshots, videos, browser proof, app proof, or layout checks;
- frontend, web, mobile, app-facing, responsive, visual, copy, or styling changes before final handoff;
- checking a screenshot/video/UI dump against an expected user workflow or visual complaint.

If a stronger project-specific proof runner exists, use it when appropriate, but still use this skill to inspect and explain the evidence before claiming success.

## Non-Negotiable Standard

Visual proof passes only when the current artifact visibly proves the requested user-facing state. A screenshot, video, or UI dump is not proof by itself.

Before claiming success, produce or verify a UI Evidence Report with:

1. **Exact workflow** - the entrypoint and user path used to reach the state.
2. **Source inputs** - issue/request criteria, screenshot complaint, manual QA notes, implementation evidence, or reproduction signal used to derive checks.
3. **Viewport coverage** - the relevant desktop/mobile/tablet sizes and why they are sufficient.
4. **Artifact freshness** - the final post-change artifacts inspected after the last run/edit.
5. **Layout review** - spacing, padding, clipping, overlap, alignment, responsive placement, and the specific visual complaint.
6. **Copy review** - user-facing labels and absence of rejected technical terms when copy is part of the task.
7. **Criterion mapping** - which artifact proves which criterion.

If any required dimension is missing, do not say proof passed. Continue the proof loop when in scope; otherwise report a blocker or residual risk.

## Workflow

### 1. Extract The Proof Target

Identify the task-specific checks before opening tools:

- user workflow: login/entrypoint, create/edit/detail/settings/modal state, relevant route or screen;
- expected state: visible controls, content, copy, data, interaction result;
- layout expectations: spacing, grouping, alignment, overflow, clipping, responsive behavior;
- copy expectations: accepted wording and rejected implementation terms;
- source inputs: issue, user request, PRD/spec, prior screenshot, manual QA plan, reproduction signal.

If criteria are underspecified, derive the smallest explicit checklist from the request and state assumptions. Ask only when ambiguity would materially change the proof.

### 2. Drive The Real UI Path

- Prefer the same entrypoint a user would use.
- When credentials are available through the repo's documented environment or smoke setup, use the real login UI.
- If you seed cookies/session state, record why the normal UI path was unavailable or irrelevant.
- For web layout proof, include a wide desktop viewport unless the task clearly excludes desktop.
- Include mobile only when the task mentions mobile/responsive behavior or the change is likely to affect small screens.

### 3. Capture Current Artifacts

Capture artifacts after reaching the exact state:

- screenshots for visual state;
- video or step screenshots for interaction flows;
- UI tree/DOM text dump when it helps verify labels or hidden overflow;
- console/log output only as supporting evidence, not a visual substitute.

Do not reuse old screenshots. Check timestamp/path or recapture after the final change. If a path is overwritten, inspect the current file before using it in the final report.

### 4. Inspect The Artifact

Look at the artifact, not only DOM selectors or test assertions.

Check:

- correct workflow/state, not a nearby equivalent screen;
- enough surrounding context, not a crop that hides the layout relationship;
- spacing/padding/breathing room;
- overlap, clipping, scroll traps, sticky headers/footers, and text truncation;
- alignment/grouping against neighboring controls;
- expected copy and absence of rejected technical wording;
- obvious loading, error, empty, stale-data, or permission states.

Use measurements when helpful, but do not let convenient geometry replace the actual visual complaint.

### 5. Decide And Act

- If the proof passes, write the UI Evidence Report.
- If proof reveals an in-scope defect and the user asked for implementation, fix it and rerun proof.
- If proof reveals an out-of-scope defect, record it as residual risk or follow-up.
- If required tools, credentials, or services are missing, report a concrete blocker with the proof attempted.

## UI Evidence Report

Use this compact format in final answers or proof notes:

```markdown
## UI Evidence

- **Workflow:** <entrypoint -> path -> exact screen state>
- **Source inputs:** <request/issue/spec/reproduction/manual QA sources used>
- **Viewports:** <viewport names and dimensions, with reason>
- **Fresh artifacts:** <current screenshot/video/UI dump paths captured after final run>
- **Layout review:** <spacing/padding/overlap/clipping/alignment findings>
- **Copy review:** <accepted labels and rejected terms checked>

| Criterion | Artifact | Evidence | Result |
| --- | --- | --- | --- |
| <criterion> | <path/url> | <what is visible and why it proves it> | Pass/Fail/Risk |
```

Keep it short. Do not include the table when the task is tiny and prose is clearer, but still cover every proof dimension.

## Failure Conditions

Treat these as proof failures:

- artifact does not show the exact requested workflow or screen state;
- only mobile/narrow proof exists for a desktop layout claim;
- artifact was captured before the final change or may be stale;
- screenshot exists but layout/copy was not inspected;
- only selector/DOM existence is verified for a visual/layout claim;
- proof uses technical labels the user rejected;
- direct session seeding bypasses a relevant login/user path without explanation.
