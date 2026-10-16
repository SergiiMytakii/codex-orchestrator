# Acceptance Proof Operation

Execute packaged [Acceptance Proof](../../skills/acceptance-proof/SKILL.md).
Runner supplies the exact checked candidate, frozen criteria, implementation
check receipts, platform evidence and output schema through the invocation.
This operation may write only proof artifacts under the supplied artifact root;
product edits and external writes are unavailable. Return the supplied proof
report schema. Mandatory implementation checks belong to the implementation
owner; their receipts apply only to the supplied unchanged candidate.

Local browser verification has loopback access only. `PLAYWRIGHT_MODULE_PATH`
resolves the installed Playwright API and `PLAYWRIGHT_BROWSERS_PATH` its prepared
browser cache. Launch Chromium headless with
`args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS || '[]')`; on macOS these
process flags keep Chromium inside the sandbox IPC boundary. Use an isolated
server and browser profile for the supplied worktree.
