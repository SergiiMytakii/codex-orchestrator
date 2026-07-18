# Containment Certificate Runtime Binding

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| A package upgrade with unchanged Codex and containment argv policy accepts the existing certificate. | Every npm package bump blocks authorized issues even when the certified containment boundary is unchanged. | `runtime accepts a certificate from an older package when Codex and containment policy are unchanged` | green |
| A changed Codex version or containment argv policy still invalidates the certificate. | Runtime drift silently exceeds the boundary proved by the canary. | `runtime still rejects a certificate when the containment policy changes`; `runtime still rejects a certificate when the Codex version changes` | green |
| Darwin-only containment certificate assertions run on Darwin and do not make the Linux npm release job fail before publication. | The release workflow runs on Ubuntu, where certificate creation intentionally rejects the host platform and previously failed all three runtime-certificate tests. | Failed GitHub Actions run `29654266424`; Darwin execution of `test/v2-containment-runtime.test.ts`; replacement Linux release run | planned |
| Contained Codex accepts the intentionally non-Git report-only read view without widening its sandbox, network, or write authority. | Every real triage/review process exits before creating its structured report. | `builds the exact contained argv and allowlisted process environment without suppressing native subagents`; targeted `real-codex` live smoke | green |
| A report-only read view contains the current tracked and untracked checked change, including deletions, while excluding repository metadata and denied content. | Reviewers inspect `HEAD` instead of the repaired worktree and repeatedly reopen already-fixed defects. | `report read view excludes env, denied paths, and symlinks before triage launch`; targeted `real-codex` live smoke closure | green |
