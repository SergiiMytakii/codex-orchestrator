# Review Protocol

This file owns mechanics shared by artifact and implementation review: bounded
capsules, Full/Closure, defect lifecycle, no-progress, waiver, and the result
envelope. Target Modules own authority, profile, topology, durable state, and
outcome mapping.

## Capsule

Every reviewer receives only:

- target kind/path and pinned revision;
- one unanswered review question and assigned lenses;
- authority, approved scope, and relevant evidence;
- compact affected validation and current defect records;
- for Closure, the repair diff and mapping from changed targets to defects and
  affected contracts.

Do not pass raw parent history, old revisions, repeated logs, or unrelated
inventories. Reuse valid coverage for the same revision, question, and lenses.

## Modes

**Full** covers the complete assigned scope once. It is bounded to the settled
target, changed owners, authority, and plausible affected contracts. It is not
a repository-wide audit and does not activate unrelated lenses.

**Closure** verifies a repair only when the finding is critical/high, affects a
trust boundary, durable data, concurrency/idempotency, shared API/DTO/schema, or
invalidates mandatory coverage. Closure stays with affected reviewer lineages
and targets. Do not launch it merely because Full found an ordinary defect.

A repair starts another Full only when mandatory-lens coverage became invalid.
A live reviewer poll timeout is non-terminal and does not authorize duplicate
review or cancellation; reconcile the recorded session first.

## Defects

Use one canonical record per distinct invariant and failure mechanism:

```yaml
id: REVIEW-CONC-003
class: blocker | execution-risk | improvement
status: open | fixed | verified | blocked | accepted-risk | superseded
severity: critical | high | medium | low
confidence: high | medium | low
invariant: "<observable rule>"
failure: "<concrete trigger and impact>"
evidence: ["<target or source>"]
repair: "<smallest sufficient change>"
affected_targets: ["<path, section, contract, or lens>"]
```

Root assigns stable IDs and deduplicates only when both invariant and failure
match. A superseded record must point to a distinct canonical replacement.
Improvements never block. Only an execution risk may become `accepted-risk`,
and only with explicit authority, reason, scope, and target revision. A blocker
cannot be accepted or downgraded.

Move blocking defects `open -> fixed -> verified`. For ordinary medium/low
behavior-preserving repairs, root may verify after checking the cited failure
path and affected validation. Closure-triggering defects require affected
independent verification.

## Repair And Stop

Repair compatible findings in one consolidated batch. Before repeating review,
the target, evidence, repair, or source decision must change materially.
Review count and elapsed time are audit signals, never approval or blocking
conditions.

Stop when repair requires a product/scope/owner decision, mandatory evidence or
reviewer is unavailable, no substantive repair exists, or the same failure
repeats without progress. Do not create micro-cycles for ordinary medium/low
findings.

Waive review only after explicit user instruction. Record skipped coverage and
open defects. Waiver is not approval and accepts no defect automatically.

## Result

```text
Review Mode: <Full | Closure>
Mandatory Coverage: <covered lenses or gaps>
Verified Defects: <IDs or None>
Accepted Risks: <IDs, authority, reason or None>
Open Defects: <IDs or None>
```

Target Modules add profile, authority, outcome, and checkpoint without
redefining these fields. For a normal medium flow, do not report internal
session accounting unless interruption, Closure, accepted risk, or another
exception makes it relevant.
