# To Tickets Publishing Details

Load this reference only when the breakdown needs spec-gate decisions,
external-contract handling, live/manual prerequisites, a publish-ready issue
template, or the full review gate for larger or coordination-heavy breakdowns.

## Spec Gates

Do not create implementation specs during issue breakdown. Mark only where a future implementation worker or orchestrator must remove ambiguity before coding.

Use these values. Review risk does not select `Spec required`; unresolved
execution ambiguity does.

- `Spec required: none` for deterministic slices with a clear existing pattern and narrow ownership, including narrow high-risk work whose contract and proof are already explicit.
- `Spec required: issue-level` for one complex issue whose implementation details must be made deterministic before a worker starts.
- `Spec required: wave-level` for several related issues that share contracts, source-of-truth files, schemas, generated artifacts, background jobs, external systems, or final live validation.

Consider `Spec required` when the slice involves any of these and the issue body plus repo context is not already deterministic enough:

- external APIs, credentials, web scraping, rate limits, licenses, downloads, or third-party terms
- database/schema/persistence changes, migrations, queues, background jobs, caching, auth, billing, permissions, or shared state
- shared DTOs, API contracts, generated types, source-of-truth configuration, or cross-app contracts
- multiple services/apps/modules that must agree on behavior
- AI-powered behavior, prompt contracts, deterministic fixtures, or live-AI smoke tests
- required Browser/manual/live smoke validation
- known rejected approaches or unresolved product/technical decisions

If an external dependency is not already machine-confirmed, create a separate HITL or AFK discovery/contract issue before implementation. That contract issue should answer:

- supported API surface
- auth/secret source
- license/terms constraints
- deterministic test fixture strategy
- live validation prerequisite
- rejected acquisition paths

Do not mark every child issue as `issue-level` just because the parent touches billing, persistence, or an external API. If the contract is shared by several issues, use one `wave-level` spec. If the issue body plus local evidence already fixes the contract, use `Spec required: none` and put the relevant proof in the issue.

When a material risk exists, state the expected Review Focus and final handoff proof whether the future gate is `none`, `issue-level`, or `wave-level`. If a spec gate is required, the future ``implementation-spec-maker`` decides compact/full mode independently from review profile and adds only the checkpoints needed by the risk.

## Rich Quiz Fields

When the breakdown has real contract, live, or validation complexity, include these extra fields in the user quiz:

- **User stories covered**: which user stories this addresses, if the source material has them
- **Spec required**: none / issue-level / wave-level, with one short reason
- **External contract status**: confirmed / needs proof / not applicable
- **Live/manual prerequisites**: any human-provided files, accounts, secrets, services, or browser checks required
- **Risk / Review**: material risk only; primary risk, main invariant, review focus, and final handoff expectation

Ask the user:

- Are the spec gates and external contract statuses correct?
- Are the high-risk review checkpoints and final handoff expectations proportionate?

## Review Gate Details

Before publishing, run the approved ticket draft through ``tickets-breakdown-review``.

For breakdowns with one or two straightforward issues, no unresolved cross-repo contract, and no live/HITL mutation, use the Mandatory lenses from ``tickets-breakdown-review`` as an inline checklist instead of route a review Runner-owned nodes.

For larger breakdowns, or breakdowns with unresolved coordination, ownership,
cross-repo, live, or HITL complexity, create a dedicated review Runner-owned nodes and
ask it to review only the parent material and the proposed issue breakdown.
High review risk alone does not require a dedicated breakdown reviewer. Treat
this skill's review gate as explicit authorization to use a parallel Runner-owned nodes
for issue-breakdown review. Do not say the user needed to request parallel
agents separately.

The review Runner-owned nodes must not publish or edit issues. It should return blockers, split/merge/reorder recommendations, acceptance-criteria fixes, and AFK/orchestration risks.

Apply all high-confidence review feedback before publishing. If the review finds blockers, revise the breakdown and show the user the updated version for approval. If feedback is ambiguous or changes product scope, ask the user a targeted question instead of guessing.

## Publish Template

Use this issue body template when publishing approved slices:

```md
## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets - they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline only the decision-rich part here and note briefly that it came from a prototype.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

For UI/user-facing issues, include at least one criterion that states the end-to-end UI walkthrough and the visual/copy state that must be proven.

## Spec gate

Spec required: none / issue-level / wave-level

Reason:

- One concise reason, or "None - straightforward implementation with existing local patterns."
- If `wave-level`, name the shared contract/flow and the sibling issues expected to share one future spec.

## External contracts

Status: confirmed / needs proof / not applicable

- API/source:
- Auth/secret source:
- License/terms constraints:
- Rejected approaches:

Or "Not applicable."

## Verification

- Automated:
- Architecture: repo architecture check if code changes.
- Manual/live: for UI/user-facing work, include ``ui-evidence-proof`` expectations for workflow, viewport, fresh artifacts, layout/copy review, and criterion-to-artifact mapping.
- Required fixtures or files:

## Risk / Review

Omit when no material risk exists.

- Primary risk:
- Main invariant:
- Review focus:
- Final handoff expectation:

## Blocked by

- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.
```
