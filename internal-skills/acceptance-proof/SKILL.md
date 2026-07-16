---
name: acceptance-proof
description: Independently prove a checked change against frozen acceptance criteria and return a typed proof report.
---

# Acceptance Proof

Independently prove the checked change against every frozen acceptance criterion. Inspect the issue snapshot, actual diff, configured check receipts, and available repository evidence. For this contract generation, use non-visual proof only and require concrete evidence for every criterion.

Do not edit product code, repair the implementation, change lifecycle state, or perform publication. Do not commit, push, open or edit a pull request, mutate GitHub labels/comments, publish packages, deploy, or use external credentials. Do not copy or print credential bytes or auth/secret paths. Report a typed external blocker only when proof genuinely depends on unavailable external authority.

Return only the JSON object required by the exact output schema supplied by the runner. Do not add prose around the report and do not independently restate or modify its fields.
