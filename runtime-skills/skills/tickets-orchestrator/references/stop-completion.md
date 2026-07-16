## Stop conditions

Stop immediately and escalate if:

- a required precondition cannot be satisfied exactly;
- a required file, symbol, or command does not exist as expected;
- a child issue cannot be validated with available repo context;
- an issue or wave requires a spec gate but the proportional spec-maker flow cannot be run or does not produce an accepted compact/full spec;
- a required external contract is not machine-confirmed, including API surface, auth, license, download/acquisition path, deterministic fixture strategy, or live validation prerequisite;
- completing a child issue would require touching protected or out-of-scope areas;
- two active workers need the same write target or source-of-truth owner;
- a worker introduces duplicate business rules, dispatch builders, normalization, persistence accounting, or compatibility layers;
- implementation would need to use a rejected approach or a non-API acquisition path that was not explicitly approved;
- review exposes a real ambiguity that cannot be resolved from code, docs, or issues;
- the next wave depends on work that is unverified, blocked, or still ambiguous.

## Completion standard

Do not mark orchestration complete until:

- every child issue is complete, blocked with evidence, or explicitly deferred;
- every reached wave exit gate has passed;
- every required issue-level or wave-level spec gate was completed with a proportional compact/full spec, and any required spec-review feedback was applied or explicitly resolved;
- every accepted implementation spec was executed through ``spec-implementer``, with a consistent `Implementation Review State`, one whole-spec review budget, and no duplicate orchestrator review loop;
- integration diffs have been reviewed and remediated;
- protected paths remained untouched and rejected approaches were not used;
- source-of-truth ownership is still singular for every material behavior;
- every behavior-changing child issue used ``tdd``, or has a concrete documented no-seam testing gap;
- repo architecture check ran when available for code changes, or was explicitly skipped with reason;
- required validation was run, or skipped checks have concrete reasons;
- repo-required ``cleanup-review`` and final ``code-review`` gates have completed for the full change set; for spec-gated work they are accounted for inside the accepted spec's Implementation Review Loop;
- for high-risk waves, the first risky state/contract wave had an explicit code-review checkpoint before lower-risk dependent waves continued;
- completed child issues have focused commits, or documented wave commits when safe separation was not possible;
- every completed child issue has a GitHub result comment and is closed, unless the user explicitly skipped delivery or GitHub closure is delivery-blocked with evidence;
- the parent issue has been updated, including a concise final risk/proof mini-report for medium/high-risk parent work, unless the user explicitly skipped delivery;
- commit/PR delivery was completed or explicitly left for the user with a clear reason.
