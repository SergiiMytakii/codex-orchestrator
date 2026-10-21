# Implementation Operation

Execute packaged [Implement](../../skills/implement/SKILL.md). It and its
referenced global skills own implementation, proof and independent
[Code Review](../../skills/code-review/SKILL.md). This file defines only the
Runner invocation and completion report contract. Available references include
[TDD](../../skills/tdd/SKILL.md),
[Diagnosing Bugs](../../skills/diagnosing-bugs/SKILL.md),
[UI Evidence Proof](../../skills/ui-evidence-proof/SKILL.md),
[Acceptance Proof procedure](../../skills/acceptance-proof/SKILL.md),
[coding routing](../../docs/agents/coding-skill-routing.md),
[bug routing](../../docs/agents/bug-workflow-routing.md), and
[tool policy](../../docs/agents/tool-usage.md).

Inputs are the authorized issue, frozen criteria, delivery authority, retained
repair findings, worktree and exact configured check commands supplied by Runner.
Complete that authorized outcome through the packaged skills in this owner
session, including applicable implementer delegation and fresh independent Spec
and Standards review. Runner reserves commits, publication, external writes and
device leases. This invocation may edit its assigned worktree, run checks and
coordinate the supplied reviewer profiles; it has no publication credentials or
authority.

When invocation declares host checks, finish source edits and return
`checks-request` with `version: 1`, `summary`, the complete `changedFiles`, and
`residualRisks`. Runner executes only its configured commands as ordinary local
processes, then resumes this same session with trusted `runnerChecks` results.
Read the full local logs, repair in-scope failures, and request fresh checks after
source changes. An unchanged failed check requires a concrete blocker. Complete
acceptance proof and independent Review only after every configured host check
passed on the current source. Copy exact ids, commands and output hashes from
Runner results into completion receipts. Source or command drift invalidates
those results. In worker-check mode, execute configured commands in the sandbox
through the supplied owner check executable. It selects native related Jest
tests from the complete candidate when safe; unsupported commands and uncertain
scope run in full. Retain its actual invocation in the complete log, with the
original configured id and command in the receipt. A related failure or empty
selection cannot pass. Report correction never executes checks.

Return one report matching the supplied implementation output schema. For
`completed`:

- `changedFiles` is the complete current source diff relative to the original
  HEAD, including retained earlier changes, excluding ignored test outputs.
- `checks` contains each required configured command's exact id, command,
  passed status and SHA-256 of its actual output, for the final source revision.
  Capture stdout and stderr from the first execution into complete local logs
  in the supplied evidence directory, retaining the actual command exit status.
  Hash the complete saved logs, not the tool display, which may truncate output.
  Reuse successful saved evidence while the candidate and check policy remain
  unchanged; do not rerun a command solely to recover displayed output.
  A failed or unavailable mandatory check cannot authorize completion. Keep
  command logs local.
- `proof` is the passed acceptance proof for every supplied frozen criterion,
  with high confidence, concrete evidence references and local artifacts.
  Only configured check ids and declared artifact ids can serve as proof evidence references; `proof.checks` remains empty. Extra owner checks stay available to Review; declare their retained output logs as artifacts when a proof criterion needs them.
  Follow the Acceptance Proof procedure within this owner session.
  For visual work, follow UI Evidence Proof and include the platform-specific
  visual evidence required by the schema after the final interaction. Preserve
  native nullable `visualEvidence` and `blocker` fields when the schema requires
  them. Never substitute uninspected screenshots or fabricate evidence.
- `review` describes the final source and proof approved by both fresh,
  independent `spec_reviewer` and `standards_reviewer` children. Include their
  distinct actual child identities returned by collaboration tools (UUIDs or
  canonical task paths), approving verdicts, a concise summary,
  all supplied coverage categories and the two final source hashes below.
  Never invent an id or a UUID mapping. The owner session cannot review itself. Finish repairs and applicable renewed
  review before claiming approval; reviewers must approve the exact final source.

Compute `review.trackedContentSha256` as SHA-256 of the exact UTF-8 stdout of
`git --no-optional-locks diff --binary HEAD` in the worktree, preserving trailing
newlines. For `review.untrackedContentSha256`, list paths with
`git ls-files --others --exclude-standard -z`, split on NUL, discard empty
entries and sort using JavaScript's default string sort. For each path, hash
its raw file bytes with SHA-256. Serialize the resulting array with compact
canonical JSON: preserve array order, sort object keys by UTF-8 bytes and use
JSON string escaping without whitespace. Each entry therefore has shape
`{"path":"relative/path","sha256":"lowercase hex digest"}`. Hash that UTF-8 JSON
with SHA-256; an empty array hashes the exact bytes `[]`. Do not stage or commit
to compute these hashes. Store generated proof and command outputs in the
Runner-supplied evidence directory outside the source candidate, or an already
ignored local output path, so the completion report cannot change its own source
binding. Any subsequent source edit requires refreshed hashes, checks, proof and
applicable review.

Before completing Android visual proof, first return
`android-proof-request` with the final `changedFiles` and configured passing
`checks`, plus `summary` and `residualRisks`. This is a finite resource request:
Runner prepares the candidate and device lease, then resumes this same owner
session with `androidProofPreparation` metadata paths, hashes and warnings.
Use only that allocated device. The acceptance-proof Android procedure analyzes
Runner-prepared artifacts; it does not authorize agent-side device commands.
If a mandatory mobile skill is unavailable, report the concrete limitation
instead of inventing commands. Preserve the prepared source and configured
check payload exactly; any drift fails closed. Complete proof and independent Review in
that resumed session and return `completed`. Do not create a separate proof
owner, claim device evidence before capture, or acquire device leases yourself.

For iOS proof, use the immutable acceptance-proof `tools/ios-lease.mjs` helper
and only the proof-bound lease, artifact, proof id, bundle, owner PID, xcrun,
runtime and device-type inputs supplied by Runner. Follow its iOS procedure
within this session; preserve every user-owned device and runtime.

Agent-side verification has loopback access only; external destinations remain denied.
Explicit host checks use the installed local tools and ordinary host network.
For browser proof, `PLAYWRIGHT_MODULE_PATH` resolves the installed Playwright API
and `PLAYWRIGHT_BROWSERS_PATH` its prepared browser cache. Launch its Chromium
headless with `args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS || '[]')`;
on macOS these process flags keep Chromium inside the sandbox's IPC boundary.
Use an isolated server and browser profile for this worktree. User-owned app and
IDE sessions remain subject to repository runtime safety rules; unavailable
proof or required leases must be reported as an external blocker.

Trusted feedback may return `answer-only` or `boundary` with no changed files.
For `external-block`, retain the existing blocker contract and report the actual
attempt and resumability. Report correction is read-only and corrects existing
evidence only.
