# Issue #1247 compact implementation spec

## Outcome

Carry the exact independently approved frozen spec authority to implementation
and review workers while retaining a single canonical hash in candidate,
Checked Change, proof, and publication bindings.

## Field-to-consumer contract

| Authority field | Source | Full consumer | Hash-only consumer |
| --- | --- | --- | --- |
| frozen content and content hash | final `SpecRevision` | implementation, independent review | candidate, Checked Change, proof, publication |
| revision number and revision hash | final `SpecRevision` | implementation, independent review | canonical authority hash |
| approval receipt and review report hash | `FrozenSpecReceipt` | implementation, independent review | canonical authority hash |
| reviewer attempt and session identity | accepted independent spec review | implementation, independent review | canonical authority hash |
| route decision hash | frozen triage receipt | implementation, independent review | canonical authority hash |

Direct authority retains its existing exact payload. Spec content cannot project
Runner policy: checks, credentials, denied paths, containment, and publication
remain inputs owned by the Runner and are not read from `DeliveryAuthority`.

## Contract Test Ledger

| Contract ID | Source authority | Approved claim | Primary ticket | Consumers | Owner / seam | Risk it prevents | First test / proof | Valid at SHA | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-AUTH-001 | #1242 DeliveryAuthority; #1247 | Workers receive exact frozen content, revision, approval receipt, and independent reviewer identity | #1247 | implementation, review | `createSpecDeliveryAuthority` and prompt/capsule inputs | hashes-only authority lets workers implement or approve bytes they never received | `v2-delivery-authority`: full frozen payload and deterministic drift cases | #1247 checkpoint | green |
| C-AUTH-002 | #1242 DeliveryAuthority; #1247 | Candidate, checks, proof, and publication bind only the canonical authority hash | #1247 | candidate, Checked Change, proof, PendingEffect settlement | existing authority-hash bindings | full spec bytes leak into effect records or a different authority is accepted after CAS/replay | production symbol trace plus run-store binding validation and affected suite | #1247 checkpoint | green |

## Verification

- Focused delivery-authority, spec-delivery, reviewer, run-store, and run-issue tests.
- TypeScript build through the focused test command.
- Contract-delta search across every `DeliveryAuthority` and
  `deliveryAuthoritySha256` consumer.
- Independent medium-profile review with correctness and amplified structural
  deletion/cleanup lenses.

No new store, lifecycle owner, compatibility path, policy projection, or
publication effect is introduced.
