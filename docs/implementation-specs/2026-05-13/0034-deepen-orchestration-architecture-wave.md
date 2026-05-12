---
title: "Deepen orchestration architecture modules wave"
created_at: "2026-05-13T00:34:09+03:00"
source_type: "wave"
source_issues:
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/116"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/118"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/117"
  - "https://github.com/SergiiMytakii/codex-orchestrator/issues/21 (final live smoke validation gate)"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_verdict: "Approved by implementation-spec-review self-review"
---

# Scope

This wave deepens two orchestration seams without changing the user-facing CLI contract:

- Local implementation session publishability is owned by one reusable module.
- Autonomous child issue lifecycle is owned by the issue-tree module.

Issue #21 is the final live smoke validation gate for the settled wave.

# Requirements

1. Scoped issue execution and plan-auto child execution must both use the same publishability decision path for report parsing, local phases, safety checks, configured checks, visual proof, review gates, and final runner-owned commit.
2. Configured check failures must block before pushing branches, opening PRs, or marking issues review-ready.
3. Plan-auto must persist and read autonomous child issues through issue-tree lifecycle helpers, including marker validation before updating existing issues.
4. Parent planning must remain commit-free and file-change-free.
5. The change must include focused regression coverage for shared publishability and autonomous child lifecycle behavior.

# Implementation Checklist

- Move configured-check aggregation to a shared runner helper.
- Add a publishability owner in the local execution session module.
- Replace duplicated scoped-auto and plan-auto child publishability logic with the shared owner.
- Move autonomous child body rendering, persistence, and readback into the issue-tree module.
- Add regression tests for publish-ready commit evidence, failed configured checks, and child lifecycle safety.
- Run focused tests, full test suite, typecheck, cleanup review, final code review, and the live smoke gate.

# Validation

Required local validation:

- `npm run build`
- focused runner tests for local sessions, scoped-auto, plan-auto, and issue-tree
- `npm run typecheck`
- `npm test`
- `git diff --check`

Required final gate:

- `npm run smoke:live`

If the live smoke gate cannot run safely because of repository state, credentials, labels, or external GitHub/Codex constraints, record the exact blocker on #21 and in the delivery summary.
