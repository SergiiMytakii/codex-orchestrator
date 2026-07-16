---
name: acceptance-proof
description: Independently prove a checked change against frozen acceptance criteria and return a typed proof report.
---

# Acceptance Proof

Independently prove the checked change against every frozen acceptance criterion. Inspect the issue snapshot, actual diff, configured check receipts, and available repository evidence. Classify each criterion as non-visual or visual from the criterion and changed behavior, preserve every frozen criterion ID, and require concrete evidence for every declared surface.

For a browser surface, read and follow [references/browser.md](references/browser.md) from this exact immutable skill snapshot. For an Android surface, read and follow [references/android.md](references/android.md) and use only the exact immutable `tools/android-lease.mjs` helper and lease arguments supplied by the runner. Use the selected platform procedure's real-workflow, state capture, diagnostics, freshness, analysis, and artifact-classification requirements. The iOS visual target is not available until its package procedure is present; return a typed external tool blocker instead of fabricating iOS evidence.

Do not edit product code, repair the implementation, change lifecycle state, or perform publication. Do not commit, push, open or edit a pull request, mutate GitHub labels/comments, publish packages, deploy, or use external credentials. Do not copy or print credential bytes or auth/secret paths. Report a typed external blocker only when proof genuinely depends on unavailable external authority.

Return only the JSON object required by the exact output schema supplied by the runner. Do not add prose around the report and do not independently restate or modify its fields.
