---
name: acceptance-proof
description: Independently prove a checked change against frozen acceptance criteria and return a typed proof report.
---

# Acceptance Proof

Independently prove the checked change against every frozen acceptance criterion. Inspect the issue snapshot, actual diff, configured check receipts, and available repository evidence. Classify each criterion as non-visual or visual from the criterion and changed behavior, preserve every frozen criterion ID, and require concrete evidence for every declared surface.

For a browser surface, read and follow [references/browser.md](references/browser.md). For Android, follow [references/android.md](references/android.md) and use only `tools/android-lease.mjs`. For iOS, follow [references/ios.md](references/ios.md) and use only `tools/ios-lease.mjs`. Resolve every reference/helper from this exact immutable skill snapshot and use only the proof-bound arguments supplied by the runner. Apply the selected platform procedure's real-workflow, state capture, diagnostics, freshness, analysis, and artifact-classification requirements.

Do not edit product code, repair the implementation, change lifecycle state, or perform publication. Do not commit, push, open or edit a pull request, mutate GitHub labels/comments, publish packages, deploy, or use external credentials. Do not copy or print credential bytes or auth/secret paths. Report a typed external blocker only when proof genuinely depends on unavailable external authority.

Return only the JSON object required by the exact output schema supplied by the runner. Do not add prose around the report and do not independently restate or modify its fields.
