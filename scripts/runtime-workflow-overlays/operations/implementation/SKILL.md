# Implementation Operation

Execute packaged [Implement](../../skills/implement/SKILL.md). It and its
referenced global skills own the procedure; this file defines only the Runner
invocation contract. Packaged references available to that procedure:
[TDD](../../skills/tdd/SKILL.md),
[Diagnosing Bugs](../../skills/diagnosing-bugs/SKILL.md),
[UI Evidence Proof](../../skills/ui-evidence-proof/SKILL.md),
[coding routing](../../docs/agents/coding-skill-routing.md),
[bug routing](../../docs/agents/bug-workflow-routing.md), and
[tool policy](../../docs/agents/tool-usage.md).

Inputs are the authorized issue, frozen criteria, delivery authority, retained
repair findings, worktree and exact configured check commands supplied by Runner.
Runner reserves independent Review, commits, publication, external writes and
device leases. This invocation may edit its assigned worktree and run checks;
it has no publication credentials or authority.

Return the supplied implementation report schema. For `completed`, `changedFiles`
is the complete current source diff relative to the original HEAD, including
retained earlier changes, excluding ignored test outputs. `checks` contains each
required configured command's exact id, command, passed status and SHA-256 of its
actual output, for the final source revision. A failed or unavailable mandatory
check cannot authorize `completed`. Keep command logs local.

Local verification has loopback access only; external destinations remain denied.
For browser proof, `PLAYWRIGHT_MODULE_PATH` resolves the installed Playwright API
and `PLAYWRIGHT_BROWSERS_PATH` its prepared browser cache. Launch its Chromium
headless with `args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS || '[]')`;
on macOS these process flags keep Chromium inside the sandbox's IPC boundary.
Use an isolated server and browser profile for this worktree.

Trusted feedback may return `answer-only` or `boundary` with no changed files.
Report correction is read-only and corrects existing evidence only.
