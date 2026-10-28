---
name: diagnosing-bugs
description: Diagnose hard, flaky, unclear, or performance bugs through reproduction, minimisation, ranked hypotheses, and targeted instrumentation. Stop after proving the root cause and hand the proven signal to Implement; do not fix the bug.
---

# Diagnosing Bugs

Establish a reliable symptom, test plausible explanations, and report a proven
cause or a concrete evidence gap. Reuse existing evidence; perform only the
steps needed to distinguish causes and support the conclusion.

## Boundaries

Follow [bug workflow routing](../../docs/agents/bug-workflow-routing.md).
This skill owns reproduction and root-cause proof, not durable regression tests,
fixes, post-fix verification, production source/runtime mutations, Git actions
(including checkouts), or tracker updates. Do not apply or recommend speculative
patches. Return to the invoking owner after diagnosis; Implement owns any
separately authorized fix. Diagnosis alone does not authorize implementation.

Read `CONTEXT.md` when present and relevant ADRs when exploring the codebase.
Use the [confidence rubric](../../docs/agents/confidence-rubric.md) for conclusions;
uncertain explanations remain hypotheses or evidence gaps, not proven causes.

## Establish and Reduce the Reproduction

Reuse an existing reproduction when it captures the reported symptom.
Otherwise build the narrowest practical command or recorded procedure.
Capture inputs, relevant state, expected behavior, and observed failure.
The signal must detect the user's actual symptom, not merely successful execution
or a nearby failure. Execute it before claiming that the symptom was reproduced.
Repeat only to establish repeatability, investigate intermittency, or test a
changed condition.

Choose the observation surface that reaches the failure: an existing test,
HTTP/CLI command, browser flow, captured trace replay, or throwaway harness.
Use differential runs, fuzzing, or bisection only when they distinguish candidate
causes. Bisection uses read-only states supplied by the invoking owner.
Prefer agent-runnable reproduction; for necessary human actions, record the
procedure and capture its output (`scripts/hitl-loop.template.sh` is available).

Reduce the reproduction until it distinguishes the suspected cause from
credible alternatives and supports implementation proof. Preserve the original
symptom and relevant state or ordering dependencies. Prefer reductions that
shorten repeated runs; stop when further minimisation would not change the
diagnosis or implementation proof. A mathematically minimal reproduction is
not required.

Prefer fast, repeatable reproductions, but preserve actual failure conditions.
For intermittent bugs, record attempts, failures, and relevant conditions.
Choose repetitions or stress by the uncertainty being tested and execution cost;
avoid fixed iteration counts. Add stress, parallelism, or timing changes only
for a specific prediction, and distinguish induced failures from the original bug.

Use source inspection and existing logs or traces to construct the reproduction
and identify candidate causes. Keep hypotheses provisional until tested.
If reproduction remains unavailable, report the missing evidence without
presenting an untested explanation as the proven cause. Request only the access,
captured artifact, or separately authorized diagnostic seam needed to proceed.

## Distinguish Causes

Rank plausible causes supported by evidence. For each investigated cause,
state a falsifiable prediction and choose a probe that distinguishes it from
credible alternatives. Do not invent alternatives to meet a count.
Share hypotheses when user knowledge could change the investigation.

Use existing observations first. Add targeted probes only when they distinguish
remaining explanations; change one relevant condition at a time. Prefer a
suitable debugger, REPL, or focused logs over broad logging. Give temporary
debug logs a unique prefix so they can be removed reliably.

If a probe can affect the symptom, remove or disable it and recheck the original
failure before relying on its result. A probe-induced failure is not proof.
If observation requires changing production source or runtime state, report the
missing seam to the invoking owner for a separately authorized Implement task;
do not make that mutation or present the unproven cause as a fix handoff.

For performance regressions, measure the baseline, then choose profiling, query
analysis, differential measurement, or bisection according to remaining
uncertainty.

## Conclusion and Handoff

Report one of two outcomes:

- **Proven cause:** the observed symptom, reproduction and relevant fixture/state,
  exact trigger, owning code path, and causal mechanism; evidence confirming the
  prediction and ruling out credible alternatives where they exist; confidence
  and remaining constraints. An unresolved assumption that changes the conclusion
  prevents a proven-cause claim.
- **Evidence gap:** observations obtained, hypotheses tested, and the specific
  evidence, access, or diagnostic seam still needed. Do not hand off a guess as
  implementation input.

An implementation-ready handoff additionally requires the exact unchanged
reproduction command already executed, captured pre-fix failing output, reduced
reproducing fixture/inputs/state/steps, and a signal digest covering the command,
fixture bytes, and expected failing verdict. If these are unavailable, state the
handoff gap even when other evidence establishes the cause.

Implement must rerun that signal before editing and obtain the same diagnosed
failure, fixture digest, and symptom, then establish durable regression proof.
Missing fixtures, a changed digest, a different symptom, or an unexpectedly green
result returns to Diagnosis or blocks the fix; do not substitute a nearby test.
For intermittent failures, include the observed rate and conditions; a green
attempt alone does not establish that the cause is absent or the bug is fixed.

Remove task-owned temporary instrumentation and unrelated prototypes. Keep a
reproduction harness and fixture needed for the handoff until Implement confirms
the same RED and creates the durable regression test. The active root then
removes them unless retention was authorized. Preserve unrelated work and shared
runtimes throughout cleanup.

Then stop. Include prevention observations only when they add a concrete,
evidence-backed insight; do not start architecture or production work.
