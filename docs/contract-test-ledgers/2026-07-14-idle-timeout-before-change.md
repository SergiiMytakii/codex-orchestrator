## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| An exact runner idle timeout with no completion report and no changed files is classified as `idle-timeout-before-change`, not as normal Codex completion without changes. | Operator diagnostics erase the real runner termination and incorrectly blame the implementation agent for completing without a diff. | `implementation publishability preserves exact idle timeout before any local change` | green |
| The default rework policy retries `idle-timeout-before-change` once and preserves the typed reason in the rework prompt and exhausted outcome. | A transient silent child run blocks immediately, loops without a bound, or loses its original cause during recovery. | `idle timeout before change sentinel has one bounded retry by default`; `scoped auto command retries idle timeout before change once with the typed reason` | green |
| Runtime config loading backfills `idle-timeout-before-change` for existing target configs. | Upgraded installations classify the timeout correctly but still hard-block until setup rewrites every target config. | `runner config reader backfills package-owned proof command and drops unsupported default npm checks` | green |
| Generic command timeouts and arbitrary exit code 124 do not enter idle-timeout recovery. | Unrelated process failures are accidentally treated as safe transient idle timeouts. | `implementation publishability does not retry generic command timeout or arbitrary exit 124` | green |
