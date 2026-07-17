# ADR 0002: Independent Acceptance Proof

Status: accepted and implemented by the V2 runtime.

## Decision

Acceptance Proof is a separate contained Codex process owned by the Runner. It receives frozen acceptance criteria and a nominal Checked Change, produces proof-owned artifacts and a strict report, and has no issue-state or publication authority.

The Runner validates exact criterion coverage, artifact hashes and containment, current checked-change freshness, forbidden proof diffs, credentials, public evidence policy, and browser or mobile evidence contracts. Mobile proof additionally requires an exact runner-owned device lease.

## Why

Implementation self-assertion is not sufficient evidence, while a fully privileged proof agent would duplicate publication and credential risk. A separate evidence producer gives adaptive inspection without transferring trusted authority.

## Consequences

- Product changes discovered during proof return as bounded implementation rework.
- Report-only repair may fix malformed JSON but may not alter or manufacture evidence.
- Credentials are rejected in every text artifact.
- Local command/static evidence may retain host paths because it is never published.
- Publishable evidence is limited to screenshots and sanitized generated summaries and must omit host identity.
- Proof cannot pass after any drift in the checked binding.
