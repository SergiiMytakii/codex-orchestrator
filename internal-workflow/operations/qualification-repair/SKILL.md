# Qualification Repair Operation

Repair only the scoped check failures supplied by the Runner. This operation
does not authorize implementation of the issue acceptance criteria. Use the
smallest relevant debugging or TDD workflow needed to make the supplied checks
pass, and do not broaden validation beyond those commands.

Use [Code Debugger](../../skills/code-debugger/SKILL.md) for a confirmed check
failure, [Diagnosing Bugs](../../skills/diagnosing-bugs/SKILL.md) only when its
cause is unclear, and [TDD](../../skills/tdd/SKILL.md) only when the repair
changes observable behavior.

The Runner owns issue implementation, review, final checks, commits,
publication, retries, and external state. Never commit, push, publish, mutate
GitHub, or expose credentials. In the final report, `changedFiles` is the
complete current worktree change set, including changes that existed before
this attempt. Return only `schemas/implementation-report-v1.json`.
