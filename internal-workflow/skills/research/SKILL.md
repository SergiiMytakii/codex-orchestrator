---
name: research
description: Investigate a material external documentation, API, SDK, specification, service-capability, or source-code question against high-trust primary sources and save one cited Markdown artifact in the repository. Use when the user explicitly requests durable research or delegated reading, even for a narrow source, or when a plan, PRD, ticket, or implementation spec depends on current external facts that require multi-source comparison or contract synthesis. Do not use for a narrow lookup without a delegation/artifact request, repo-only exploration, bug reproduction, or an answer that belongs entirely to a specialized documentation skill.
---

# Research

Resolve one external question into reusable evidence for downstream coding work.
The invoked skill authorizes one `researcher_standard` child; root owns source
verification, artifact integration, user communication, and later decisions.

## Route Proportionately

- Read local evidence first: manifests, lockfiles, installed source, tests,
  configs, ADRs, and repository docs.
- Keep one narrow documentation lookup inline unless the user explicitly requests delegation or a durable artifact. When the lookup stays inline, use the owning specialized docs skill or tool and answer in chat without creating an artifact.
- Invoke this workflow when the user requests delegated reading or a saved research result, or when a material decision needs multi-source comparison, freshness checking, or external contract synthesis.
- Use repo exploration or bug-diagnosis skills when the owning evidence is local
  code or runtime behavior. Research may supply one external contract input but
  never owns bug reproduction or implementation.

## Build The Research Capsule

Before delegation, record:

- the exact question and decision it must unblock;
- relevant verified local context;
- in-scope and excluded products, versions, environments, and claims;
- allowed primary-source types and required freshness;
- the repository output path.

Use the repository's existing research-note convention. If none exists, choose
`docs/research/YYYY-MM-DD/HHMM-<slug>.md`.

## Delegate One Bounded Question

Launch one fresh `researcher_standard` child with the Research Capsule and no
inherited conclusions. The child is read-only and must return:

1. a short answer;
2. a claim-to-source ledger for every material fact;
3. source version or publication/update date when available;
4. conflicts, uncertainty, and missing evidence;
5. clearly labelled inferences for the repository decision.

While it reads, continue only independent local work. Do not make or implement
the blocked decision before the research returns. If the named role is
unavailable, perform the same bounded workflow inline and report the fallback;
do not substitute an unrelated code explorer or reviewer.

## Source Standard

Prefer the source that owns the claim:

1. official documentation or specifications;
2. first-party source code, changelogs, release notes, or issue trackers;
3. first-party APIs or published schemas.

Use secondary material only to discover primary sources or to expose a disputed
interpretation. Never promote it to authority when an owning source exists.
Cite the exact page or repository location that supports each material claim.
Separate sourced fact from inference, and state when current behavior cannot be
confirmed.

Use specialized source adapters when applicable: for example, `$openai-docs`
for OpenAI products, Context7 for precise package documentation, and site
parsers for extraction. Their output still must satisfy this source standard.

## Verify And Save

Root must open and verify every source behind a claim that changes architecture,
scope, implementation, security, cost, or compatibility. Repair unsupported or
overstated claims, then save exactly one Markdown artifact:

```markdown
# <Research question>

## Decision To Unblock
<decision and relevant local context>

## Short Answer
<concise answer>

## Findings
| Claim | Primary Source | Version / Date | Confidence |
| --- | --- | --- | --- |
| ... | ... | ... | ... |

## Repository Implications
<clearly labelled inferences and affected plans/specs/tickets>

## Conflicts And Unknowns
<conflicting sources, stale evidence, and unresolved questions>
```

Do not include credentials, private tokens, or copied secrets. Link or cite
sources instead of reproducing long copyrighted passages.

## Downstream Contract

- Return the saved path and the decision it now supports.
- Let plans, PRDs, tickets, and implementation specs cite the artifact as their
  external Evidence Map instead of repeating the research.
- Re-read only claims invalidated by changed versions, dates, contracts, or
  source conflicts.
- Treat the artifact as evidence, not implementation authority. Behavior-changing
  work still follows the normal TDD, implementation, and review routes.
