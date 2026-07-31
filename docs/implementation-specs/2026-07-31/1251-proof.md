# Issue #1251 completion proof

Baseline: #1250 checkpoint `063ae4f`.

## Result

- Direct-review recovery accepts only the exact current
  `direct-review-report-malformed` terminal discriminator. The
  `allowLegacyMalformed` option, production branches, and positive legacy
  recovery behavior are deleted.
- Run-state inspection accepts only the exact current
  `codex-orchestrator.run-state` schema. Unknown top-level keys and records
  missing the lifecycle discriminator are unsupported.
- An absent state file remains the only clean-start case. Old, unknown,
  malformed, and missing-discriminator bytes return
  `state-schema-unsupported` without changing the bytes.
- Unsupported bytes are rejected before repository owner-lock acquisition and
  before state, evidence, backup, directory, worktree, ref, cleanup, Git, or
  GitHub effects.
- No migration, reset, converter, dual-write, downgrade, rollback, or fallback
  reader was added. This is the clean cutover required by #1242 and ADR 0001.

## Verification

- Exact current direct-review discriminator and legacy-missing discriminator:
  1/1 passed.
- Current, old, unknown, malformed, and missing-discriminator run-state
  fixtures, including byte preservation and pre-lock effect exclusion: passed.
- Nested terminal direct-review cutover through the production run-state parser
  and `RunIssue` preflight: 3/3 passed, including a positive exact-current
  fixture and a negative legacy fixture with unchanged bytes and no owner lock
  or effects.
- Direct-delivery and run-store affected suites after the review repair: 16/16
  passed.
- Typecheck and `git diff --check`: passed.
- Production symbol search for `allowLegacyMalformed`, legacy malformed-state
  acceptance, and compatibility reader seams: no matches.

The independent Full review found one high-severity nested-schema bypass:
legacy terminal direct-review state without `terminalCode` was supported even
though recovery declined it. The validator now requires the exact discriminator
and binds it to the enclosing Run internal-error code. Its historical Contract
Ledger row now records exact-discriminator recovery and the negative pre-lock
legacy fixture.

The bounded Closure check requested that the exact-current positive fixture
traverse `RunIssue`, not only the file parser. The fixture now proves successful
current-state recovery through the real preflight path before replaying the
legacy-missing bytes through the same path; the final focused rerun passed.
