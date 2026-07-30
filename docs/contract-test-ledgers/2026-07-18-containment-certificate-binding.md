# Containment Certificate Runtime Binding

Status: superseded historical ledger.

> Runtime certification was removed on 2026-07-28. This file preserves the
> tests and release evidence for the former certificate gate; its green rows do
> not describe a current runtime requirement. The active replacement contract
> is [Runtime Containment Without Certification](2026-07-28-runtime-containment-without-certification.md).

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| Configuration has no Codex version pin; the canary certifies whichever `codex` command is installed. | A package hardcode rejects the locally installed CLI before containment can be proved. | `runtime accepts a certificate for the installed Codex version without a configured version pin` | green |
| A changed installed Codex binary or containment argv policy still invalidates a stale certificate until the canary certifies the current binary. | Runtime drift silently exceeds the boundary proved by the canary. | `runtime still rejects a certificate when the containment policy changes`; `runtime still rejects a certificate when the Codex version changes` | green |
| Darwin-only containment certificate assertions run on Darwin and do not make the Linux npm release job fail before publication. | The release workflow runs on Ubuntu, where certificate creation intentionally rejects the host platform and previously failed all three runtime-certificate tests. | Failed GitHub Actions run `29654266424`; Darwin execution of `test/v2-containment-runtime.test.ts`; successful replacement Linux release run `29654323122` | green |
| Contained Codex accepts the intentionally non-Git report-only read view without widening its sandbox, network, or write authority. | Every real triage/review process exits before creating its structured report. | `builds the exact contained argv and allowlisted process environment without suppressing native subagents`; model-backed package-install live smoke | green |
| A report-only read view contains the current tracked and untracked checked change, including deletions, while excluding repository metadata and denied content. | Reviewers inspect `HEAD` instead of the repaired worktree and repeatedly reopen already-fixed defects. | `report read view excludes env, denied paths, and symlinks before triage launch`; model-backed package-install live smoke closure | green |
