---
name: "code-review"
description: "Review code changes or existing code with an evidence-first two-lens process. Use for code review, PR review, commit audit, regression scan, bug hunt, or review-and-fix work. Automatically fix only critical or high-severity high-confidence issues that satisfy the auto-fix policy. For spec-driven work, use one final profile-selected wave with bounded cleanup in the spec/standards lens."
---

# Code Review

This skill performs evidence-based code review. It is not a style pass and not a summary. Treat the change as potentially wrong until independent review tracks fail to break it.

The review always covers two lenses:

- **Correctness reviewer**: bugs, regressions, runtime behavior, security, contracts, caches, concurrency, framework rules, and failure paths.
- **Spec & standards reviewer**: requested behavior, documented repo standards, architecture fit, duplication, cleanup, and workaround-shaped implementation.

The main agent is the coordinator. It pins the review target, assigns both
lenses to one reviewer for `simple` and `medium`, and splits them across two
independent reviewers only for `high`. It verifies the strongest findings,
applies only safe fixes, and returns a concise findings-first report.

## When To Use

Use this skill when the user asks for:

- code review, PR review, commit audit, regression scan, or bug hunt
- review since a branch, commit, tag, merge-base, or working tree state
- review and fix of critical or high-severity high-confidence defects
- framework-focused review such as `NestJS`, `Next.js`, `Flutter`, or `Dart`

For every implementation profile, the spec/standards lens includes bounded
cleanup for duplication, obsolete paths, workaround branches, and unjustified
abstractions. High-risk work assigns that lens to its own reviewer in the same
parallel final wave. Run separate `$cleanup-review` first only for an explicit
concrete evidenced reason that cannot fit this bounded lens.

Exception for approved spec execution: follow
`../../docs/agents/implementation-review-loop.md`. Intermediate code-review
checkpoints do not automatically run cleanup first; final cleanup and final code
review use the durable Review Plan and canonical Defect Ledger.

## Implementation Review Adapter

When this skill is called from `$spec-implementer`:

- read the Module and persisted `## Implementation Review State`
- accept the scheduled mode, session, revision, and lenses from that state
- pin the target and give reviewers the Module-defined capsule
- return the usable result and stable defect updates to the executor
- when exceptional separate cleanup ran, consume its settled decisions/IDs and avoid broad hygiene rediscovery unless a code-review repair caused a concrete regression

Do not infer a fresh review loop, choose another mode, or make the Module's
terminal decision inside this Adapter.

## Progressive References

Read only the references the current review needs:

- Detailed bug classes: `references/bug-classes.md`
- Framework lenses for Next.js, NestJS, Flutter, and Dart: `references/framework-lenses.md`
- Targeted recipes for recurring diff shapes: `references/targeted-recipes.md`
- Contract test ledger: `../../docs/agents/contract-test-ledger.md`
- Shared confidence rubric: `../../docs/agents/confidence-rubric.md`

Load `references/framework-lenses.md` when the user names a framework or files/configs strongly imply one. Load `references/targeted-recipes.md` and `../../docs/agents/contract-test-ledger.md` when the diff shape matches new fields, retries, DTO/schema/runtime contracts, caches, state merge precedence, ordering, evidence/snapshots, determinism, or aggregation summaries. Load `references/bug-classes.md` for substantial reviews or broad bug hunts.

## Coordinator Workflow

### 1. Pin The Review Target

Identify exactly what is being reviewed.

- If the user gave a fixed point, use it directly: branch, commit SHA, tag, `main`, `HEAD~5`, etc.
- If they did not, infer from context:
  - current uncommitted work: `git diff` plus staged diff if relevant
  - branch review: `git diff <base>...HEAD`
  - commit review: `git show <commit>`
- If there is no safe inference, ask one short question: "Review against which branch or commit?"

Capture:

- `git status --short`
- diff stat
- the exact diff command used
- commit list when reviewing a branch range
- changed files and nearest related tests/docs

Use three-dot diff for branch/base reviews: `git diff <fixed-point>...HEAD`.

### 2. Discover Spec And Standards

Do this before reviewer tracks so both tracks receive bounded inputs.

Spec sources, in priority order:

1. Issue or PR references in commit messages, branch names, PR metadata, or user prompt.
2. A spec/PRD/plan path supplied by the user.
3. Matching files under `docs/`, `specs/`, `.scratch/`, or local issue folders.
4. If none exists, continue and mark the spec axis as "no spec found" instead of inventing requirements.

Standards sources:

- `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`
- `CONTEXT.md`, context maps, domain docs, ADRs
- `STYLE.md`, `STANDARDS.md`, style guides, review checklists
- `.editorconfig`, ESLint, Biome, Prettier, TypeScript, analyzer, or framework configs
- relevant test files and existing examples in the touched area

Machine-enforced config matters as context, but do not spend review findings on issues a required formatter/linter would already catch unless the tool is absent or failing.

### 3. Activate Lenses

Before deep review, decide which lenses apply.

- Always activate the general correctness and spec/standards lenses.
- Add framework lenses when explicit or strongly implied by files/configs.
- Add targeted recipes when the diff shape matches them.
- If the user, plan, or implementation spec provides `Review Focus`, treat each listed lens, targeted recipe, invariant, and risk as mandatory. Do not replace it with a generic review; report any focus item that cannot be verified as a verification gap.
- If inference is uncertain, say so and continue with the best-supported review instead of pretending certainty.

Mandatory delta lenses:

- **Contract Delta Review:** If the diff expands a shared contract, enum/status, schema, DTO, permission, capability, token, or scope, search old consumers and report `changed contract -> searched call sites -> risky fallback/default branches -> tests or fix`.
- **Backend Trust Boundary Review:** If the diff adds a credential, OAuth scope, permission, role-sensitive write, or external capability, verify the backend-side guard. UI controls, query/state flags, and caller intent are not authorization.

Common framework signals:

- **Next.js**: `next.config.*`, `app/**`, `pages/**`, route handlers, server actions, `use server`, `use client`, revalidation APIs.
- **NestJS**: `@nestjs/*`, controllers, providers, modules, guards, pipes, interceptors, DTOs, `nest-cli.json`.
- **Flutter**: `pubspec.yaml`, `lib/**`, widgets, navigation, bloc/provider/riverpod/notifiers.
- **Dart**: `.dart`, `Future`, `Stream`, isolates, generated serializers, null-safety constructs.

### 4. Run Profile-Selected Reviewers

For `simple`, run one `reviewer_fast`; for `medium`, run one
`reviewer_standard`. Assign that child both correctness and spec/standards
lenses in one bounded Full review. For `high`, run two `reviewer_deep` children
in parallel with one disjoint lens each. Invoking `$code-review` authorizes
these reviewers. Preserve every fulfilled launch handle if a parallel peer
fails, then close all launched children. Tell every reviewer not to edit or
revert unrelated work.

For spec-driven checkpoints, obey the track assignment in the persisted Review
Plan instead of automatically launching both default tracks.

When already inside an assigned reviewer child, execute its assigned lens set
inline and return it to root; do not spawn a grandchild.
If the user forbids delegation, report the independent review gate as waived or
unavailable according to the parent workflow; root must not self-review inline.

#### Correctness Reviewer Brief

Include the exact diff command or commit under review, changed file list, commit list, active references, any `Review Focus`, and an instruction to read surrounding execution paths.

> Review runtime correctness adversarially. Hunt concrete bugs in control flow, state, async/concurrency, security, auth, contracts, schemas, caching, persistence, UI/API integration, and framework-specific behavior. If a Review Focus is provided, explicitly test the named risks first, such as duplicate side effects, retry/idempotency, ordering, source-of-truth ownership, partial failure, DTO/schema drift, or false user-facing state. For each finding, provide file/line, trigger path, impact, why guards do not prevent it, severity, and confidence. Do not report style nits or generic "needs tests" comments.
> For bugfixes, check claim boundaries: what changed tests prove, what they do not prove, and whether sibling execution paths can still violate the claimed invariant.
> When Contract Delta Review applies, follow new values through old consumers and default/fallback branches before trusting local tests. When Backend Trust Boundary Review applies, verify the server-side authorization predicate at the write/callback boundary.

#### Spec & Standards Reviewer Brief

Include the exact diff command or commit under review, spec source path/content or "no spec found", standards source list, changed file list, commit list, any `Review Focus`, and an instruction to cite the spec or standard behind each finding.

> Review the change against the requested work and repo standards. Check missing requirements, partial behavior, scope creep, undocumented contract changes, architecture drift, duplicate source-of-truth logic, dead/legacy branches, and workaround-shaped implementation. If a Review Focus is provided, explicitly verify each named ownership, scope, validation, and invariant risk against the spec. Cite the spec or standard when available. If there is no spec, skip requirement claims and focus on documented standards and architecture evidence.

### 5. Aggregate And Verify

The coordinator must not blindly relay reviewer output.

1. Deduplicate findings across tracks.
2. Re-read the relevant code for the strongest findings.
3. Drop findings that lack a concrete trigger path.
4. Reclassify severity/confidence using `../../docs/agents/confidence-rubric.md` if evidence does not support the label.
5. For real contract defects, identify the missing or inadequate Contract Test Ledger invariant when TDD/spec evidence is available.
6. Confirm every mandatory `Review Focus` item and mandatory delta lens was reviewed; if not, report the unverified item as a verification gap.
7. Decide whether auto-fix is allowed.
8. Run the narrowest meaningful verification after any fix.

Keep the two axes visible in your own notes, but present the final report by severity unless the user explicitly asked for side-by-side Standards/Spec output.

For a Module-scheduled Closure, send the bounded Closure capsule to the supplied
reviewer session and return its defect updates to the executor.

## Evidence Standard

A valid finding explains:

- what breaks
- why it breaks
- the input, sequence, role, tenant, environment, or timing that triggers it
- where the defect lives
- why existing guards do not prevent it
- severity and confidence

Do not file:

- style nits disguised as correctness issues
- speculative races without a shared-state path
- generic "needs tests" comments without a concrete regression risk
- architecture discomfort without wrong ownership, duplication, leakage, or a regression path
- performance comments without a hot path or failure mode

## Auto-Fix Policy

Automatically fix only when all are true:

- severity is critical or high
- confidence is high under `../../docs/agents/confidence-rubric.md`
- root cause is clear
- correct fix is narrow and low-risk
- fix matches local project patterns
- verification is available, or the edit is obviously safe and syntax-checkable

When auto-fixing:

- patch only the bug
- add/update behavior tests when regression risk is meaningful and the codebase supports it; for contract defects, add the missing ledger invariant first when a ledger exists or is being created
- rerun relevant verification
- never revert unrelated user changes

Do not auto-fix ambiguous semantics, product decisions, broad refactors, or low-confidence concerns. Report them with evidence.

## Output Contract

For review-only tasks:

1. Findings first, ordered by severity.
2. File and line references for each finding.
3. Trigger path, impact, severity, confidence, and evidence.
4. Open questions, assumptions, or verification gaps.
5. Short summary only after findings.

For review-and-fix tasks:

1. State which critical or high-severity high-confidence issues were fixed.
2. Report remaining findings that were not fixed.
3. Give one short verification note and any blocked checks.
4. Keep the closing summary user-facing and outcome-based.

If there are no findings, say so clearly and mention residual test or verification gaps.

For spec-driven review checkpoints or final review gates, include a compact review handoff that can feed the executor's Final Risk Handoff: reviewed target, Review Focus status, high/critical findings fixed or remaining, skipped checks, and residual verification gaps. Keep findings first.

If inline review comments are requested, emit one `::code-comment{...}` directive per actionable finding.

## Tooling Defaults

- Use `rg`/`rg --files` for code search.
- Prefer parallel reads for status, diff, changed files, related modules, tests, repo docs, and standards.
- Use official docs or Context7 only when a finding depends on version-sensitive framework/library behavior.
- Run the narrowest meaningful tests first, then required lint/build/analyzer checks for touched areas.
- Keep raw command output out of the final response unless the user asks for it.

## Decision Defaults

- If the user says "review", default to findings-first review.
- If the user says "review and fix", auto-fix only critical or high-severity high-confidence issues that satisfy the auto-fix policy.
- If the user provides a framework focus, explicitly use it.
- If no focus is provided, infer active lenses from the diff and say when they materially affected findings.
- Ask clarification only when the correct review target or fix would otherwise be risky or ambiguous.
