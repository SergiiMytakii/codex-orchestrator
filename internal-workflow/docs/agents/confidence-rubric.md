# Confidence Rubric

Use this rubric for coding skills that report findings, diagnose root causes, review specs, or decide whether an auto-fix is safe.

Do not use fake numeric precision unless a skill has a concrete scoring reason. Prefer `high`, `medium`, and `low` with evidence.

## High Confidence

High confidence means the finding or diagnosis has direct evidence.

Requires:

- a concrete trigger path, code path, failing signal, or tool output
- a clear explanation of why existing guards do not prevent the issue
- no unresolved assumption that changes the conclusion

Allowed actions:

- report as a finding
- block execution when the issue is safety-critical or spec-critical
- auto-fix only when the fix is narrow, low-risk, local-patterned, and verifiable

## Medium Confidence

Medium confidence means the issue is likely but one explicit assumption remains.

Requires:

- strong local evidence
- exactly what assumption remains
- what evidence would promote or demote the finding

Allowed actions:

- report as a likely issue, risk, or execution concern
- ask a targeted question when the unresolved assumption changes the fix
- do not auto-fix unless new evidence raises confidence to high

## Low Confidence

Low confidence means the concern is plausible but not proven.

Requires:

- a clear label as uncertainty
- the missing evidence or verification gap

Allowed actions:

- present as a question, risk, or verification gap
- do not report as a proven bug
- do not auto-fix

## Auto-Fix Gate

Auto-fix is allowed only when all are true:

- confidence is high
- root cause is clear
- fix is narrow and low-risk
- fix matches local project patterns
- verification is available, or the edit is syntax-checkable and obviously safe
- the change does not require a product decision

If any condition is missing, report the issue with evidence and stop before editing.
