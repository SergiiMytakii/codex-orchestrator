# Acceptance Proof Operation

Follow the packaged [Acceptance Proof skill](../../skills/acceptance-proof/SKILL.md).
Never change product behavior or external state. Return only
`schemas/proof-report-v1.json`.

The Runner already supplied the exact schema through `--output-schema`. Do not
search for, open, or infer a repository-relative schema file; inspect only the
frozen criteria, changed targets, checks, and requested proof evidence.

The host Runner owns Flutter/Dart analysis, tests, and builds for every proof
level, including `tests-only`. Do not rerun those commands, copy the SDK, or
attempt sandbox workarounds. Independently inspect the changed behavior and
test coverage, and use the supplied passed check receipts only for the exact
checked candidate. Skipped local Flutter commands are not an external blocker;
missing, failed, or stale required receipts do not establish acceptance.
