---
name: diagnosing-bugs
description: Diagnose hard, flaky, unclear, or performance bugs through reproduction, minimisation, ranked hypotheses, and targeted instrumentation. Stop after proving the root cause and hand the proven signal to Implement; do not fix the bug.
---

# Diagnosing Bugs

A diagnosis-only discipline for hard bugs. Skip phases only when explicitly justified. End with a proven root cause or an honest blocker.

Routing precedence: use [`../../docs/agents/bug-workflow-routing.md`](../../docs/agents/bug-workflow-routing.md). This skill owns reproduction and root-cause proof. It does not own the regression test or fix, post-fix verification, production mutation, or Git lifecycle. Once the cause is proven, hand the reproducible signal and evidence to `implement` and stop.

Use [`../../docs/agents/confidence-rubric.md`](../../docs/agents/confidence-rubric.md) when deciding whether a hypothesis or root cause is high-confidence enough to report or hand off. Low-confidence concerns are questions or verification gaps, not proven causes.

When exploring the codebase, read `CONTEXT.md` (if it exists) to get a clear mental model of the relevant modules, and check ADRs in the area you're touching.

## Phase 1 — Build a feedback loop

**This is the skill.** Everything else is mechanical. If you have a **tight** pass/fail signal for the bug — one that goes red on _this_ bug — you will find the cause; bisection, hypothesis-testing, and instrumentation all just consume it. If you don't have one, no amount of staring at code will save you.

Spend disproportionate effort here. **Be aggressive. Be creative. Refuse to give up.**

### Ways to construct one — try them in roughly this order

1. **Existing failing test** at whatever seam reaches the bug — unit, integration, e2e. Do not turn the repro into a new durable regression test in this skill.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (snapshot, dataset, version), automate "boot at state X, check, repeat" over read-only states supplied by the active driver. Diagnosis performs no checkout or other Git action.
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs.
10. **HITL bash script.** Last resort. If a human must click, drive _them_ with `scripts/hitl-loop.template.sh` so the loop is still structured. Captured output feeds back to you.

Build the right feedback loop, and most of the diagnostic uncertainty is gone.

### Tighten the loop

Treat the loop as a product. Once you have _a_ loop, **tighten** it:

- Can I make it faster? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem, freeze network.)

A 30-second flaky loop is barely better than no loop; a 2-second deterministic one is tight — a debugging superpower.

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not — keep raising the rate until it's debuggable.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for: (a) access to whatever environment reproduces it, (b) a captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) an authorized Implement change that adds the missing diagnostic seam. Do **not** proceed to hypothesise without a loop, and do not edit production source or runtime state from this skill.

### Completion criterion — a tight loop that goes red

Phase 1 is done when the loop is **tight** and **red-capable**: you can name **one command** — a script path, a test invocation, a curl — that you have **already run at least once** (paste the invocation and its output), and that is:

- [ ] **Red-capable** — it drives the actual bug code path and asserts the **user's exact symptom**, producing a signal that `implement` can later use for red/green proof. Not "runs without erroring" — it must be able to _catch this specific bug_.
- [ ] **Deterministic** — same verdict every run (flaky bugs: a pinned, high reproduction rate, per above).
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended; a human in the loop only via `scripts/hitl-loop.template.sh`.

If you catch yourself reading code to build a theory before this command exists, **stop — jumping straight to a hypothesis is the exact failure this skill prevents.** No red-capable command, no Phase 2.

## Phase 2 — Reproduce + minimise

Run the loop. Watch it go red — the bug appears.

Confirm:

- [ ] The loop produces the failure mode the **user** described — not a different failure that happens to be nearby. Wrong bug = wrong diagnosis.
- [ ] The failure is reproducible across multiple runs (or, for non-deterministic bugs, reproducible at a high enough rate to debug against).
- [ ] You have captured the exact symptom (error message, wrong output, slow timing) so later phases can prove what produces it.

### Minimise

Once it's red, shrink the repro to the **smallest scenario that still goes red**. Cut inputs, callers, config, data, and steps **one at a time**, re-running the loop after each cut — keep only what's load-bearing for the failure.

Why bother: a minimal repro shrinks the hypothesis space in Phase 3 and gives `implement` a precise signal to preserve while fixing the bug.

Done when **every remaining element is load-bearing** — removing any one of them makes the loop go green.

Do not proceed until you have reproduced **and** minimised.

## Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly ("we just deployed a change to #3"), or know hypotheses they've already ruled out. Cheap checkpoint, big time saver. Don't block on it — proceed with your ranking if the user is AFK.

## Phase 4 — Instrument

Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** in a throwaway harness or an already-authorized diagnostic surface at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup at the end becomes a single grep. Untagged logs survive; tagged logs die.

If distinguishing the hypotheses requires changing production source or runtime state, stop with that missing instrumentation seam and hand it to `implement`. Diagnosis may describe the smallest observation point, but it does not apply that mutation.

**Perf branch.** For performance regressions, logs are usually wrong. Instead: establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, isolate the cause second.

## Phase 5 — Prove the root cause and hand off

Prove the winning hypothesis against the tight loop before reporting it as the root cause:

1. Name the exact trigger, owning code path, and mechanism that produces the observed symptom.
2. Show the probe result that confirmed the winning prediction and the result that ruled out the strongest alternative.
3. Re-run the unchanged repro after removing or disabling the probe. It must still produce the original symptom; a probe-induced failure is not proof.
4. Classify confidence with the confidence rubric. If an assumption still changes the conclusion, report the remaining verification gap instead of claiming a proven cause.
5. Remove all `[DEBUG-...]` instrumentation and unrelated throwaway
   prototypes. When the red signal depends on a throwaway harness, keep the
   minimal repro harness and fixture available with the handoff until Implement
   confirms the same RED and creates the durable regression test. This narrow
   executable handoff artifact is not production code or a Git action; after
   confirmation, the active root removes it unless the user authorized it to
   remain.

Then stop. Do not author a regression test, apply or recommend a speculative patch, run post-fix checks, commit, push, open a PR, or update a tracker. Hand `implement`:

- the exact unchanged reproduction command and captured pre-fix failing output;
- the minimal load-bearing fixture, inputs, state, and steps;
- a signal digest covering the command, fixture bytes, and expected failing verdict;
- the proven trigger, owner, mechanism, and supporting probe evidence;
- the strongest alternative ruled out and how it was falsified;
- any missing test seam, environment dependency, or residual uncertainty that constrains implementation proof;
- post-mortem observations about what could have prevented the bug, clearly separated from the proven cause and without starting architecture or production work.

The handoff is executable evidence, not narration. Implement must rerun the
unchanged signal before editing and get the same diagnosed failure. A missing
fixture, changed digest, different symptom, or unexpectedly green result
returns to Diagnosis or blocks the fix; Implement must not silently substitute
a nearby test.

If the root cause is not proven, do not hand off a guess as implementation input. Return the best red-capable signal, tested hypotheses, and the concrete evidence or access still required.

## Output Contract

Use this shape when reporting back:

```md
## Reproduction

- Command: `<exact command already run>`
- Signal: <captured symptom and repeatability>
- Minimal scenario: <load-bearing inputs, state, and steps>

## Proven root cause

- Trigger: <what activates the bug>
- Owner: `<path>` — `<function or method>`
- Mechanism: <how the owner produces the symptom>
- Evidence: <confirming probe and falsified alternative>
- Confidence: <high, medium, or low, with any remaining gap>

## Implement handoff

- Preserve this signal: <exact unchanged reproduction command, captured pre-fix failing output, minimal load-bearing fixture, signal digest, and expected failing verdict>
- Constraints: <missing test seam, environment dependency, or residual uncertainty>
- Post-mortem observations: <prevention or architecture evidence for later authorized work>
- Next owner: `implement`
```

When the cause is not proven, replace `Proven root cause` and `Implement handoff` with `Blocked diagnosis`; list tested hypotheses and the exact missing evidence. Do not route implementation from an unproven diagnosis.
