---
name: ui-evidence-proof
description: Verify visual fidelity and responsive behavior for UI implementations, including Flutter and web, with fresh running-app screenshots. Compare supplied designs, including Figma and Pencil, and fix in-scope differences. Also use for UI audits and visual proof requests.
---

# UI Evidence Proof

Use from initial design inspection through final handoff for UI, layout, styling,
copy, and responsive changes. This is an agent instruction, not a machine-enforced
gate. Tests, builds, DOM assertions, and screenshots without comparison do not
prove design fidelity.

## Workflow

### 1. Establish the target

Before UI edits, open and inspect the exact design frame and available properties.
Keep its reference image or frame link. Derive a compact checklist covering:

- section order, dimensions, spacing, alignment;
- typography, colors, borders, radii, icons and images;
- copy, interaction states, and required viewport variants.

For a supplied design, use each in-scope frame's viewport dimensions as a
reference for exact visual comparison. Use the project's supported sizes and
layout conventions to derive behavior between frames and at other widths.
Size containers and columns to the available space and let content wrap or
reflow as needed. Keep intentional fixed dimensions, such as icon sizes.

Record only user-approved deviations. Reuse existing components when they can
match the target; do not silently simplify it. Label image-derived measurements
as estimates. If no design is supplied, use the request and project UI conventions.
If a supplied reference is inaccessible, obtain it before guessing its appearance.

**Done:** reference, criteria, approved deviations, and required states/viewports
are identified.

### 2. Capture the current UI

Reach the exact state through the real user path in the correct app/environment.
Explain any relevant login/session bypass. Confirm the runtime contains the
current changes; capture fresh screenshots after the last edit, including needed
scroll positions and states. Use video or step screenshots for interactions.
Widget/golden renders and logs support this proof but do not replace running-app
screenshots.

Cover the specified viewport sizes. For responsive layout work with a supplied
design, capture the running UI for each in-scope frame
at its reference viewport size and sample a supported width between distinct
reference widths. With a single reference width, also cover narrow and wide
supported widths, using the reference capture for either end it already covers.
For web layout, include desktop unless excluded and small screens when
responsive behavior is affected.

For Flutter Android use `$flutter-android-debug` plus
`test-android-apps:android-emulator-qa`; for iOS use `$flutter-ios-debug`.
Use `$flutter-attach-session` for runtime discovery/control and obey its owner
and launch gates. Preserve user-owned sessions.

**Done:** fresh rendered artifacts cover the required workflow and changed scope.

### 3. Compare and correct

Inspect reference and actual images side by side at equivalent viewport, scroll
position, theme, locale, text scale, and content/state. Account for device pixel
ratio and system insets; document alignment crops/scaling without hiding affected
UI. Overlays, diffs, and measurements may help, but a passing metric never excuses
a visible mismatch.

Check every criterion plus overflow, clipping, overlap, truncation, and loading,
empty/error states relevant to the task. Sample content or platform rasterization
may differ; this does not excuse incorrect layout, missing assets, raw IDs, or
broken labels.

At widths without a matching frame, verify the expected reflow, text wrapping,
and control usability. Check for unintended horizontal scrolling.

During implementation, fix in-scope differences without another approval request,
refresh through the safe runtime path, recapture, and compare again. Recheck the
affected screen after the last correction. For a read-only audit, report findings
without edits; report unrelated defects separately.

**Done:** all criteria pass. Known in-scope differences or missing visual proof
block completion; neither “close enough” nor an iteration limit ends the loop.
If access, runtime, permission, or an unresolved scope decision blocks progress,
complete independent authorized work and report the exact blocker and remaining
criteria as incomplete.

## Handoff

Give a compact UI Evidence Report in the final answer or linked proof note:

- reference/frame, criteria, and approved deviations;
- workflow/state, viewport dimensions, and fresh artifact links;
- comparison findings and criterion-to-artifact Pass/Fail/Blocked results;
- any blocker, unverified scope, and what is needed to resume.

Use a table only when it helps. Claim completion only when the final rendered UI
passes the comparison throughout the authorized scope.
