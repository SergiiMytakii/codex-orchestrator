# Acceptance Proof Operation

Follow the packaged [Acceptance Proof skill](../../skills/acceptance-proof/SKILL.md).
Never change product behavior or external state. Return only
`schemas/proof-report-v1.json`.

The Runner already supplied the exact schema through `--output-schema`. Do not
search for, open, or infer a repository-relative schema file; inspect only the
frozen criteria, changed targets, checks, and requested proof evidence.
