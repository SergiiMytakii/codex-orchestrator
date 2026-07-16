---
name: tickets-breakdown-review
description: Reviews spec-to-ticket breakdowns for tracer-bullet quality, dependency correctness, AFK readiness, acceptance criteria, proportional scope, and orchestration risk before tickets are published. Use when reviewing child ticket drafts, implementation ticket breakdowns, vertical slices, or to-tickets output.
---

## Package Runtime Authority

This node may read only Runner-supplied context and may write only within its signed execution policy. It must not create or close issues, post comments, publish, commit, push, select another skill, or invoke native delegation. When retained source guidance asks for any such effect, return a structured recommendation artifact to the Runner; the Runner alone owns external publication and repository checkpoints. This authority rule overrides conflicting workflow wording below.

# Tickets Breakdown Review

Review a draft set of child tickets before they are published or handed to agents.

## Invocation mode

For non-trivial ``to-tickets`` breakdowns with real coordination, ownership, or live/HITL complexity, this skill runs in a dedicated parallel Runner-owned nodes. The parent agent should route the review Runner-owned nodes, pass only the parent material and proposed ticket breakdown, continue any non-conflicting local prep while the review runs, then apply the review feedback before publishing.

Do not choose an inline review just because the user did not separately ask for parallel agents. This skill is the required Runner-owned nodes review step for non-trivial issue breakdowns.

Exception: ``to-tickets`` may use this skill's Mandatory lenses as an inline checklist for one or two straightforward tickets with no unresolved cross-repo contract and no live/HITL mutation.

## Review posture

Be adversarial, concrete, and short. The goal is to catch bad slicing before it becomes six confusing tickets. Do not rewrite the full breakdown unless explicitly asked; give targeted fixes the parent agent can apply.

## Inputs to request or infer

- Parent spec, plan, PRD, or tracker issue.
- Draft child tickets with titles, type, blockers, acceptance criteria, and user stories covered.
- Out-of-scope items from the parent.
- Known repo ownership boundaries and risky shared modules when available.

## Mandatory lenses

- **Tracer-bullet quality:** each issue should deliver a narrow, complete, verifiable behavior path, not a horizontal layer task.
- **Granularity:** no giant issues that hide multiple slices; no tiny issues that cannot be verified on their own.
- **Sizing correctness:** reject both over-splitting deterministic work and collapsing independently owned or independently verifiable workflows into one ticket. High risk alone does not justify another ticket.
- **Small-fix proportionality:** for narrow bugs or deterministic repairs, prefer one complete implementation issue plus an optional live/HITL issue over a multi-issue program.
- **Dependency graph:** blockers must be real, acyclic, minimal, and ordered for publishing.
- **AFK/HITL classification:** AFK issues must have enough context and deterministic acceptance criteria; HITL issues must identify the human decision needed.
- **Acceptance criteria:** criteria must be observable, testable, and tied to the issue behavior rather than implementation chores.
- **Scope control:** child issues must not smuggle in parent out-of-scope work.
- **Scope deletion:** recommend merging or removing tickets and mechanisms before adding coordination, infrastructure, or operational scope.
- **Source-of-truth risk:** flag duplicated business rules, competing ownership, or repeated normalization/dispatch/persistence logic across issues.
- **Parallelization risk:** flag issues likely to collide if assigned to Runner-owned nodes in the same wave.
- **Spec proportionality:** flag repeated `issue-level` spec gates when one shared `wave-level` spec would be enough.
- **High-risk proof flow:** for medium/high-risk breakdowns, verify that the first issue or wave proving the main state/contract risk is explicit, has the right spec gate, and is not buried behind lower-risk UI/copy/polish work.
- **Final handoff proportionality:** small tickets should not require heavy reports; medium/high-risk parent work should require a concise final risk/proof handoff back to the parent spec or tracker issue.
- **Final coverage:** complex plans should include a final integration/regression slice when individual slices do not prove the full scenario together.

## Output format

Always answer in this exact structure:

1. `🎯 Вердикт: Approved / Needs Work / Rejected` plus one sentence with the main reason.
2. `💪 Сильные стороны` with 2-3 bullets.
3. `⚠️ Blockers перед публикацией` with concrete findings and failure mechanics.
4. `🔪 Split / Merge / Reorder` with exact issue-level changes to make.
5. `🧪 Acceptance Criteria fixes` with criteria that need to become more testable.
6. `🤖 AFK readiness and orchestration risk` with Runner-owned nodes collision risks, spec-gate proportionality, and safer wave order.
7. `📌 Risk / proof handoff` with whether high-risk proof flow and final handoff expectations are proportionate.
8. `❓ Жесткие уточняющие вопросы` with only questions that block publication.

If there are no blockers, say so explicitly. Keep the review decision-oriented; avoid generic praise.

## Decision rules

- `Approved`: breakdown is coherent, vertical, scoped, and safe to publish.
- `Needs Work`: breakdown is directionally sound but needs edits before publishing.
- `Rejected`: breakdown is horizontal, unsafe, too vague, or materially mis-scoped.
