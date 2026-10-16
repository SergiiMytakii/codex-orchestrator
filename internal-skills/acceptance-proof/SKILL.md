---
name: acceptance-proof
description: Prove the owner implementation against frozen acceptance criteria using Runner-bound evidence and leased mobile resources.
---

# Acceptance Proof

Within the active Implement owner session, prove the final change against every frozen acceptance criterion. Inspect the issue snapshot, actual diff, configured check receipts, and available repository evidence. Classify each criterion as non-visual or visual from the criterion and changed behavior, preserve every frozen criterion ID, and require concrete evidence for every declared surface.

For a browser surface, read and follow [references/browser.md](references/browser.md). For Android, follow [references/android.md](references/android.md) and inspect only the Runner-prepared artifacts named in the prompt; never invoke Android device, emulator, Flutter, or lease helpers. For iOS, follow [references/ios.md](references/ios.md) and use only `tools/ios-lease.mjs`. Resolve every reference/helper from this exact immutable skill snapshot and use only the proof-bound arguments supplied by the runner. Apply the selected platform procedure's real-workflow, state capture, diagnostics, freshness, analysis, and artifact-classification requirements.

During evidence capture, keep the source unchanged. If proof reveals a product defect, return to the active Implement procedure for authorized repair and repeat the affected proof before Review. Do not change Runner lifecycle state or perform publication. Do not commit, push, open or edit a pull request, mutate GitHub labels/comments, publish packages, deploy, or use external credentials. Do not copy or print credential bytes or auth/secret paths. Report a typed external blocker only when proof genuinely depends on unavailable external authority.

Build the nested `proof` field of the owner completion report using the exact schema supplied by Runner. This skill is an evidence procedure within Implement, not a separate operation or agent. Retain frozen criterion IDs and actual evidence; unavailable required proof cannot become a passing report.
