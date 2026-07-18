# Implementation Spec Template

Use the base template for every spec. Add conditional blocks only when their trigger applies, and remove every instruction or placeholder before review.

## Base Template

```markdown
---
title: "<title>"
created_at: "<ISO timestamp>"
source_type: "plan | issue | contract-discovery | revised-spec"
source_plan: "<absolute path or None>"
source_issues:
  - "<URL/reference or None>"
status: "draft | ready | blocked"
execution_model: "single-agent | multi-agent"
spec_mode: "compact | full"
implementation_size: "small | medium | large"
expected_repositories: <positive integer>
review_profile: "simple | medium | high"
review_reasons:
  - "<signal: evidence>"
review_outcome: "Pending"
review_verdict: "Not run"
review_coverage: "Not reviewed"
review_passes: "0"
---

## 1. Execution Context
- **Goal:** <one observable outcome>
- **Source Material:** <exact references>
- **Approved Scope:** <strict allowed work>
- **Out of Scope:** <explicit exclusions or None>
- **Minimum Solution:** <direct path through existing owners and public seams>
- **Added Complexity:** None | <repeat one entry per mechanism: `<mechanism>` — required for `<invariant or evidenced failure>`; without it `<concrete breakage>`>
- **Primary Risk:** <main correctness or coordination risk>

## 2. Preconditions And Evidence
- **Required Services / Env / Fixtures:** <exact requirements or None>
- **Blocking Unknowns:** <exact unknowns when blocked, otherwise None>
- **Confirmed Targets:** <minimal evidence-backed paths and symbols>
- **Confirmed Commands:** <exact commands>
- **Protected Paths / Rejected Approaches:** <items or None>
- **Source of Truth:** <existing owner whenever behavior/data can drift; otherwise omit>
- **New Boundaries:** <only when ownership or a public seam changes; otherwise omit>

## 3. Execution Slices

### Slice 1 — <narrow end-to-end behavior>
- [ ] **Test/Proof First:** <failing behavior test or exact observable proof>
- [ ] **Target:** `<exact/path:symbol>` — <specific action>
- [ ] **Validation:** <target-level check>
- [ ] **Exit Gate:** <command or proof that the slice works end-to-end>

<repeat only for independently verifiable behavior slices>

## 4. Validation And Done Criteria
- [ ] **Lint/Format:** <exact command or Not applicable with reason>
- [ ] **Typecheck/Build:** <exact command or Not applicable with reason>
- [ ] **Tests:** <exact command or Not applicable with reason>
- [ ] **Architecture Check:** <exact command or Not applicable with reason>
- [ ] **Live/Manual Proof:** <exact flow or Not applicable with reason>
- [ ] **Behavior Proof:** <observable acceptance proof>
- [ ] **Reconciliation:** every unchecked item is unfinished, blocked with evidence, or intentionally not applicable.
- [ ] **Final Handoff Requirements:** <medium/high only: standard `$spec-implementer` Final Risk Handoff plus task-specific deviations or None>
```

## Conditional Blocks

### Contract Test Ledger

Add for contract-heavy behavior using the shared Contract Test Ledger referenced by `SKILL.md`. Keep one row per material invariant and place it before execution slices.

### Review Checkpoint And Focus

Add a checkpoint only when the risky target becomes stable before later slices. Otherwise put this compact block in final review coverage:

```markdown
## Review Focus
- **Mandatory Lenses:** <applicable lenses>
- **Targeted Recipes:** <applicable recipes or None>
- **Bug Classes:** <concrete failures to hunt>
```

### Risk Controls

Add in `full` mode only for applicable ambiguity:

```markdown
## Risk Controls
- **Source of Truth:** <owner>
- **Safety / Contract / State Constraints:** <only applicable constraints>
- **Forbidden Scope:** <tempting but rejected paths>
- **Review Timing:** <stable early checkpoint or concrete final-review focus>
```

### Write Scope Summary

Add for multi-agent work, generated artifacts, broad runtime changes, or when phase targets do not make the write set auditable.

```markdown
## Write Scope Summary
- `<path>` — <Create | Update | Delete>; <responsibility>
```

### Integrator Coordination Contract

Require only when `execution_model: "multi-agent"`:

```markdown
## Integrator Coordination Contract
| Agent | Exclusive Write Scope | Handoff | Merge Phase |
| --- | --- | --- | --- |
| <agent> | <disjoint paths> | <artifact> | <order> |

- **Integrator Owner:** <owner>
- **Forbidden Overlap:** <paths/contracts>
- **Final Duties:** <integration, validation, reconciliation>
```

### Halt Conditions

Add only when the common contradiction/guessing stop rule is insufficient. Use 3–6 task-specific conditions.

### Defect Closure Notes

Add only when review returns defects:

```markdown
## Defect Closure Notes
- **Review Summary:** <pass counts and coverage>
- **Verified Defects:** <stable IDs or None>
- **Accepted Risks:** <stable IDs, authority, and reason or None>
- **Open Defects:** <stable IDs or None>
```

## Terminal Review Metadata

Replace the temporary frontmatter values after the Artifact Review Module returns a real terminal outcome:

```yaml
review_outcome: "Approved | Blocked | Waived"
review_verdict: "Approved | Needs Work | Rejected | Not run"
review_coverage: "<covered lenses or Not reviewed>"
review_passes: "<total; full/closure/fresh counts>"
```
