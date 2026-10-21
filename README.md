# Codex Orchestrator

Codex Orchestrator turns one explicitly authorized GitHub Issue into a controlled Codex delivery run. Planning remains external. The package implements the issue in an isolated Git worktree, validates the immutable candidate, and—only after all required gates pass—pushes a branch and opens a draft pull request.

The package is designed for unattended local execution without giving the Codex worker your GitHub, SSH, npm, or cloud publication credentials. The trusted Runner owns authorization, process ownership, recovery, evidence admission and publication. One native Codex session owns source changes, verification decisions, proof and independent Review through synchronized global skills. Explicit host checks are finite Runner actions requested by that session.

## What happens to an issue

Add the configured `agent:auto` label to an open executable issue, then run the orchestrator. That label authorizes only that issue. The lifecycle is `one Codex session: implementation → checks → proof → independent Review`, followed by Runner publication. A product or ownership decision gap is returned as an issue-local blocker for external Plan; the package does not create a PRD, spec, or ticket graph.

Ordinary technical choices do not stop the run. A human question is reserved for real product ambiguity.

## Requirements

- Node.js 18 or newer
- `git`
- an authenticated [GitHub CLI](https://cli.github.com/) (`gh auth status`)
- an installed Codex CLI and an authenticated parent Codex installation
- a GitHub repository with a usable `origin` remote

The target path passed to every command must be absolute.

For browser verification, install the headless Chromium version required by the
package's Playwright SDK once on the Runner host:

```sh
npx --no-install playwright-core install chromium --only-shell
```

The implementation session can bind and reach loopback services only. Runner
passes the matching SDK, browser cache and macOS sandbox launch arguments to the
worker; Review remains read-only without network access.

## Quick start

Install the package in the repository you want to automate:

```sh
npm install --save-dev codex-orchestrator
```

Create the repository policy and GitHub labels:

```sh
npx codex-orchestrator setup --target "$PWD"
npx codex-orchestrator setup --target "$PWD" --prepare-labels
npx codex-orchestrator doctor --target "$PWD"
```

`setup` derives the base branch only from `origin/HEAD`. When an agent performs setup, it must show that detected branch and obtain explicit user confirmation before running the mutating setup command. If repository inference is not possible, provide both repository fields:

```sh
npx codex-orchestrator setup \
  --target "$PWD" \
  --github-owner your-org \
  --github-repo your-repo
```

For a trusted Flutter project, select its ordinary installed SDK explicitly:

```sh
npx codex-orchestrator setup --target "$PWD" --flutter-sdk "/absolute/path/to/flutter"
```

Setup validates `bin/flutter` and runs `--version`, then records quoted absolute
commands for `pub get --enforce-lockfile`, analyze, and tests in `checks`. It enables
`runner.checkExecution: "host"`: these commands execute repository code with the
Runner user's normal SDK, package cache and network, without publication tokens.
SDK paths containing spaces and shell metacharacters are supported on the existing
POSIX host runtime. Setup does not install or copy SDKs. A dry run checks the
executable but skips `--version` to avoid SDK cache writes. Repeated setup preserves
an existing configuration; SDK changes require editing its check commands.

It writes `.codex-orchestrator/config.json` and adds the generated workspace, state, and proof directories to `.gitignore`. If the repository has `test` or `typecheck` npm scripts, setup adds them as default checks. Review the generated config before the first run.

Now create or choose a clear GitHub Issue, include acceptance criteria when possible, and add the `agent:auto` label. Run it directly:

```sh
npx codex-orchestrator run --target "$PWD" --issue 123
```

The command prints one JSON result. Successful delivery returns `review-ready` with the draft PR URL. Decision, authority, preservation, and proof boundaries return a precise blocked result with evidence.

For external candidate discovery, use the package-owned remote baseline rather than the caller's local branch:

```js
import { withRemoteBaseWorktree } from 'codex-orchestrator';
const { baseSha, result } = await withRemoteBaseWorktree(targetRoot, async ({ worktreePath }) => {
  return analyzeRepository(worktreePath);
});
```

The helper fetches the configured remote base, analyzes a temporary detached worktree, and removes it afterward.
It rejects results if the remote base changes during analysis. Record `source-base-sha:<baseSha>` on its own
line in the issue body. Both direct runs and the daemon reject a different fresh or persisted execution base
before claiming a new run; they never reset an existing run to a new base. Issues without this metadata
keep their normal configured-base behavior.

## Main commands

### `setup`

Create or verify the strict repository policy:

```sh
npx codex-orchestrator setup --target "$PWD"
```

Preview setup writes without changing files or labels:

```sh
npx codex-orchestrator setup --target "$PWD" --dry-run
npx codex-orchestrator setup --target "$PWD" --prepare-labels --dry-run
```

Setup accepts the current exact configuration schema only. Unknown or older configuration shapes are rejected rather than guessed or executed through a compatibility runtime.

### `doctor`

Check that the config is valid, the configured repository matches `origin`, no active owner makes setup unsafe, and all configured labels exist:

```sh
npx codex-orchestrator doctor --target "$PWD"
```

### `status`

Run the same read-only operational inspection in a status-oriented command:

```sh
npx codex-orchestrator status --target "$PWD"
```

Both `doctor` and `status` return structured JSON and make no repository or GitHub changes.

### `run`

Run or safely resume one issue:

```sh
npx codex-orchestrator run --target "$PWD" --issue 123
```

Repeated calls do not start an unrelated second run. The Runner reads durable state, reconciles unfinished effects, revalidates issue authorization, and continues only when ownership and process state are safe.

An external blocker stops until renewed GitHub authorization; ordinary polling does not relaunch a worker against the same unavailable environment.

One native Codex session owns implementation, configured commands, acceptance evidence, and independent Spec and Standards Review through the synchronized global skills. Runner resumes the exact saved session UUID after process cleanup; it does not launch separate proof or Review coordinators.

The owner returns one completed report with exact command receipts, proof, reviewer identities and source hashes. Runner validates this report against the unchanged candidate and configured policy before publishing. Malformed reports retain their bytes and receive a bounded correction in the same session with read-only permissions. Missing evidence, failed checks, changed source or ambiguous process ownership cannot authorize publication.

Android visual proof can request the existing Runner-owned isolated runtime after source and checks are complete. Runner prepares it against the pinned checked candidate, then resumes the same session with trusted artifact metadata. Device identity, lease, artifact freshness and cleanup checks remain mandatory.

Before a new run is claimed, the Runner fetches only the configured remote base branch, pins its exact commit, and creates the issue worktree from that immutable SHA. A temporary fetch failure remains unclaimed and safely retryable; existing runs keep their already-persisted base SHA.

### `daemon`

Poll for open issues carrying `agent:auto` and process them serially:

```sh
npx codex-orchestrator daemon --target "$PWD"
```

Run exactly one polling pass—for example from cron or another scheduler—with:

```sh
npx codex-orchestrator daemon --target "$PWD" --once
```

For a bounded one-shot daemon check of one discovered candidate, add
`--issue <number>` after `--once`. Continuous daemon mode intentionally has no
issue filter.

The daemon uses the same lifecycle as `run`; it does not have a less strict execution path.

### Continue from pull-request review feedback

After a run reaches `review-ready`, the daemon also
polls issues with `agent:review`. A quiet PR remains effect-free. When the same
marker-bound, same-repository draft PR receives a new unresolved inline thread
root or a non-empty `CHANGES_REQUESTED` review from a current repository writer
or admin, the Runner freezes that exact feedback batch and resumes the existing
run through the same targeted repair lifecycle.

The frozen batch enters the same implementation with verification → required device proof →
targeted independent review loop used by in-scope repair. The reviewer receives
the previous revision, repair delta, blocker IDs, direct impact cone, and affected
proof. There is no semantic round limit. Publication appends one fast-forward
commit to the existing branch and PR; divergence blocks without reset, rebase,
amend, or force-push recovery.

Feedback is re-read with fresh permission before workers and publication
effects. Edited, deleted, revoked, wrong-head, cross-repository, bot, resolved,
outdated, ordinary conversation, and read-only feedback cannot authorize work.
The Runner posts one marker-bound PR summary after success, but it never resolves
review threads or claims human approval. Thread resolution remains a reviewer
action.

## Labels and visible outcomes

The default labels are:

| Label | Meaning |
| --- | --- |
| `agent:auto` | The issue is authorized for orchestration. |
| `agent:running` | A Runner has claimed the issue. |
| `agent:blocked` | The run stopped on an authority, external, preservation, proof, or safety boundary. |
| `agent:review` | The branch and draft PR passed the delivery gates and are ready for human review. |

Important command results:

| Result | What to do |
| --- | --- |
| `review-ready` | Open the returned draft PR URL and review the change; later trusted unresolved feedback may resume the same run and PR. |
| `repair-ready` | The semantic repair batch is durably ready. Run one more bounded CLI call or daemon tick; live smoke continues only up to its fixed limit. |
| `not-eligible` | Check that the issue is open, has only the appropriate authorization label, and has no existing open PR for its branch. |
| `requeued` | Another known Runner owns the repository; retry later. |
| `blocked` | Read `kind`, `resumable`, and `evidencePath`; fix the external condition only when the evidence says it is safe to resume. |
| `transport-failed` | A local or remote effect could not be confirmed. Re-run only when `resumable` is true; the Runner will reconcile durable intent first. |

All outcomes include structured evidence or a path to local evidence. Quiet terminal output is not the source of truth—the JSON result and persisted state are.

GitHub reads retry temporary network failures, HTTP 429/5xx, and explicit rate
limits up to three attempts, with 250 ms and 500 ms backoff within the original
command or collection deadline. Cancellation stops further attempts. Writes,
permission failures, missing resources, and invalid payloads are not retried.
Issue-read failures retain the bounded, sanitized original error and GitHub
stderr in local evidence.

Resumable owner-session process failures retain `failure.kind`, exit code,
signal, report availability, and a bounded sanitized diagnostic in local
evidence. An idle timeout is reported as `idle-timeout`, without claiming a
service outage. A later ordinary invocation resumes the same native Codex session after confirmed process cleanup.

On an internal Acceptance Proof failure, the Runner also attempts to retain an
`acceptance-proof-diagnostic` in `<runner.stateDir>/v2/evidence/<runId>.json`.
It contains a bounded, filtered cause, candidate commit, package version, and
existing workflow generation/manifest hashes. Diagnostic storage is best-effort;
failure still stops before Review or publication. The CLI's terminal evidence
path retains the terminal outcome separately. Workflow hashes identify bundled
instructions and schemas, not compiled Runner code: equal package versions and
workflow hashes do not establish identical Runner behavior. Compare the actual
installed compiled files when investigating a source/install discrepancy.

Delivery guarantees depend on repository policy and issue format. Frozen
criteria recognize a Markdown `Acceptance Criteria` heading and `-`/`*` bullets
(including checkboxes); without those bullets, one criterion covers the entire
title and body. The repository configuration is the only source of mandatory
executable checks. An Issue's `Verification` text describes expectations for
implementation and Acceptance Proof; Markdown, wording, and command examples
never select, replace, or add executable checks. Every configured check must pass
after the final source edit before required device proof, Review, and publication.

In explicit host-check mode the implementation session returns `checks-request`
after final edits. Runner runs configured commands in insertion order, stops on
failure, and resumes the same session with complete local logs and trusted results.
Proof and independent Review follow passing host checks. Source changes, command
changes or substituted output hashes invalidate the results. A crash during host
execution leaves an unfinished action rather than rerunning commands automatically.
The existing owned-command fence protects unresolved process groups.

Checks run in the implementation worktree, after the final source edit. The worker
keeps full logs locally and reads failures itself; Runner never relays a truncated
log or launches a separate worker verification phase. Generated logs belong in ignored artifact paths;
the completed report identifies the complete source diff. Runner captures and pins
that exact source tree, binds the worker's check results to it, and supplies those
results to independent Review. Later source drift, changed required commands,
missing verification, denied-path changes, ambiguous process ownership and
publication divergence still prevent delivery. A report is worker evidence, not
an independent execution attestation; Review must evaluate its adequacy.

A failed mandatory check stays with the implementation owner for an in-scope
repair or a concrete blocker. Before declaring an unexplained failure outside
scope, the owner uses focused and baseline reproductions. It retains the first
failed log and repeats the exact policy only when diagnostic evidence justifies
a transient/environment recovery or an in-scope repair. Explicit host checks are finite Runner actions;
source ownership, proof and Review remain in the same Codex session.

Android
startup failure may remain an unfinished-UI-proof warning. Synthetic fixtures
and static workflow evals do not establish live browser or agent behavior.

Review receives the complete exact patch. Capsules larger than 1 MiB use a
Runner-owned file in the existing read-only view, bound by SHA-256 and byte length.
Credential checks, report limits and required Review coverage still apply.

Run state is stored under `<runner.stateDir>/v2/runs/<repository-sha256>/<issue>.json`.
Each file has its own CAS generation and size limit. Large immutable history is
stored as hash-verified evidence chunks; all consumed feedback remains available.
On the first owned write, a valid legacy `run-state.json` migrates under the
repository owner lock, with exact destination verification and its original bytes
preserved as `run-state.json.backup`. Run only one Runner version over this stateDir
during migration. Interrupted migration resumes by verifying existing files;
divergence or missing migrated records blocks execution. Unknown candidate refs
and materializations are preserved, including when another stateDir may own them.

GitHub owns execution permission; the local journal retains progress and history.
An open stopped issue is authorized again while it carries the configured `auto`
label and has no conflicting running/blocked/review labels. Removing `blocked`
is sufficient; the `auto` label does not need to be removed and re-added, and no
new label event is required. The Runner still validates immutable outcome evidence
and resumes the same Run, branch and checked candidate after ownership, worktree
and pending-effect checks. Each newly authorized cycle uses the current package
workflow and response schema while preserving the native session. Stale terminal
notifications cannot undo it. Existing open PRs continue through
the Review feedback path rather than a replacement delivery.

The daemon combines complete GitHub discovery with local runs requiring
reconciliation, cleanup or notification delivery. Every tick binds discovery and
execution to one current config snapshot. Technical terminal comment/label failures
retry once per tick without an exhaustion budget. Marker/body divergence remains a
safety stop; a delivery error does not change the proven outcome.

Short Runner commands share cancellation with the current tick. The repository
owner lock records command launches before execution and clears them only after
confirmed settlement. An unresolved process group, stream, or interrupted launch
keeps ownership blocked; restarting the Runner cannot admit another command by
assuming the previous process disappeared.

An owner-lock refusal does not prove a stale lock. Foreign host/boot ownership
stays blocked even if the recorded PID is absent; a live Darwin worker cannot
prove matching start identity. Do not remove locks or reset state to force
progress. Legacy `codex-orchestrator.agent-auto-state` envelopes (versions 2/3)
are accepted only when every record fully validates against the current execution
contract. Reads preserve original bytes; the next normal state write uses the current
format. Removed execution fields and missing authority are never ignored. Unsupported
state returns a bounded `reason` with repair/archive guidance, without progression effects.
Starting a new journal requires preserving the old file and checking ownership/resources first.

## Configuration you will usually edit

`.codex-orchestrator/config.json` is intentionally strict: unknown keys are errors. The most useful fields are:

- `github.baseBranch` and `github.labels`: where completed branches target and which labels control the workflow.
- `runner.pollIntervalSeconds`: daemon polling interval.
- `runner.checkExecution`: optional `"host"` opts trusted projects into ordinary
  local checks with installed tools; omission retains sandboxed worker execution.
- `checks`: mandatory commands executed in configured order after the final source edit.
  In host mode Runner executes them; otherwise the implementation worker does.
  Source edits after Review require fresh checks. Issue descriptions cannot
  waive them. Runner requires exact successful results before publication.
- File lists in issues are starting points, not exhaustive allowlists. The
  authorized outcome owns scope: implementation may update directly affected
  callers, tests, fixtures, and wiring needed to complete that same outcome;
  unrelated behavior and new decisions remain out of scope.
- `proof.artifactDir`: repository-relative location for proof artifacts inside the run worktree.
- `proof.android`: optional Runner-owned Android recipe. It selects `avdName`, creates an ephemeral clean data directory, requires fixed `build apk` arguments, removes any old `apkPath`, snapshots a fresh no-symlink APK outside the worker-writable tree, and binds its digest to the checked change. It installs and launches that exact snapshot, repeatedly verifies emulator process identity, waits up to `navigationTimeoutMs` for each exact `tapText` accessibility label, and captures proof-bound screenshot, hierarchy, PID log, and lease artifacts. Commands are bounded, cancellable, and process-group quiescent; URI query/fragment credentials are rejected. The contained proof worker never receives `adb`, emulator, Flutter, or durable lease authority. Emulator or Android-tool startup failure is retained as an explicit unfinished-UI-proof warning and does not by itself block delivery.
- `deny.readPaths`: paths the worker must not read or modify.
- `deny.commands`: absolute command paths that must not be exposed to the worker.

The branch template and containment settings are fixed policy in the current schema rather than open-ended tuning knobs. Semantic repair counts are not stop conditions. There is no configured Codex version pin or local certification step: the Runner uses the installed `codex` command and applies the fixed sandbox, environment, network, and authority restrictions to every worker invocation.

## Safety model in plain language

The package separates two roles:

- The **Runner** is trusted. It owns GitHub reads and writes, labels, comments, worktrees, configured checks, process lifecycle, commits, pushes, draft PRs, proof validation, and recovery state.
- Codex **workers** are bounded. They receive operation-specific instructions and a contained environment. They can inspect and change the assigned worktree or create proof-owned artifacts, but they do not receive publication credentials or permission to publish.

Codex and native Codex subagents still run as your local OS user and may use your existing Codex authentication. This is containment of authority, not an OS-level secrecy boundary. Credentials are scrubbed from worker environments and rejected in reports and proof artifacts.

## Explicit Flutter proof

Flutter self-improvement issues may carry one `## Proof requirements` JSON block:

```json
{"version":1,"level":"tests-only","reason":"Focused tests establish the async completion contract.","authentication":"none","steps":[]}
```

`tests-only` uses the implementation owner's configured checks and acceptance evidence, followed by independent Review, without a separate Acceptance Proof process or Android launch. `android-live` requires a Runner-owned emulator and fresh Android visual evidence; its `steps` are bounded `tap`/`expect` actions with exact UI text, `back`, or `swipe` (`up`/`down`). The final step must be an `expect`. `authentication: "dev-account"` additionally requires a configured `proof.android.login` command and args; the trusted helper receives the exact debug APK build arguments, digest, live emulator lease and serial on stdin, then must return `authenticated_identity_verified` with the same app PID and canonical user ID. These inputs and credential handling remain with the host Runner. Missing tools, login or required evidence blocks publication rather than becoming a warning. Issues without this block retain their existing proof policy.

Android cleanup stops only the leased emulator with its recorded process identity, removes its temporary device data, install snapshot, prepared state and host lease, and retains proof evidence. Cleanup failure retains the settled proof outcome and candidate worktree for a later invocation to retry cleanup before Review or publication; it does not rerun the app scenario. Terminal cancellation or revoked issue authority also requires releasing retained mobile resources.

Configure Flutter checks with absolute commands for the pinned SDK, such as `/opt/sdk/bin/flutter analyze --no-pub --no-fatal-infos` and `/opt/sdk/bin/flutter test --no-pub test/..._test.dart`. Include dependency preparation in the configured commands when required. Use setup `--flutter-sdk` to opt into ordinary host execution. Runner executes these exact commands after a `checks-request`, then resumes the same Agent for proof and independent Review. Other configurations retain sandboxed worker checks. Receipts are admitted only for the unchanged source and configured policy. Levantem uses `--no-fatal-infos`: errors and warnings block delivery while info diagnostics remain visible in local check output.

Delivery remains implementation with checks → required runtime proof → independent Review → draft PR. The run completes as `review-ready`; the issue closes through the PR's `Closes` reference when it merges.

Reviewer receipts retain the actual child identity exposed by native collaboration
(UUID or canonical task path). They never require a fabricated UUID mapping.
Distinct reviewer roles/identities, owner exclusion, final source binding and both
approving verdicts remain mandatory.

### Related Jest checks

In worker-check mode the implementation owner invokes the supplied package check
executable for each configured command. Recognized plain npm/Jest scripts use
Jest's native `--findRelatedTests` over the complete diff from the run's base,
including untracked source files and changed tests. Related failures and empty
selections block completion. Configuration, deleted or unsupported files,
executable Jest configuration, npm lifecycle hooks and local global Jest modules
retain the full configured command. Build and typecheck stay complete. Host-check
mode retains its exact full commands.

The helper runs inside the same owner process tree; Runner gains no separate
check/repair phase. Logs record the original policy and actual invocation; receipts
remain bound to the unchanged source and exact configured policy. Independent
Review must inspect the selected scope and results.

## Development and release checks

For package maintainers:

```sh
npm run refresh:workflow
npm run typecheck
npm test
npm pack --dry-run --json
```

`npm run refresh:workflow` rebuilds the package-owned workflow inventory from the explicit allowlist in `scripts/agent-auto-workflow-source.json`, validates operation bindings, and runs focused contract tests. `npm run check:workflow` is the non-writing drift check; `npm run verify:workflow` verifies the committed generated workflow without reading local skills.

Global personal skills are the process authority. Local operations and profiles
only define invocation inputs, reserved authority and report formats; runtime
prompts point directly to the imported source skill. Update generated copies
through workflow refresh, never by hand. Each Run keeps its immutable workflow
snapshot, so a later refresh affects new Runs without changing active ones.

Packaged skill eval files are static target scenarios. Workflow refresh and
package tests validate their schema, uniqueness, and exact generated bytes;
they never launch Codex or a real agent.

`npm run smoke:live` packs the current package and mutates a configured scratch GitHub repository. Run it only when live smoke was explicitly requested. Releases are published by the GitHub release workflow after the release commit reaches `main`; do not run `npm publish` manually unless that workflow is unavailable.

Human maintainers can find the complete lifecycle, state machine, containment boundary, retry budgets, review flow, proof contracts, and publication recovery model in [docs/deep-dive.md](docs/deep-dive.md). That guide is not agent context. For live release scenarios, see [docs/live-smoke-checklist.md](docs/live-smoke-checklist.md).

An optional future reliability pilot starts with shadow verification of saved
candidates, then 5–10 small tasks in one scratch repository with one scheduler
and manual publication. Inject restart, duplicate dispatch, unknown effects,
reboot, and foreign-branch faults only in scratch runs. Success means verifying
the exact candidate SHA, no duplicate effects, clear blocker causes, and
detection of a known defect. This procedure does not authorize execution or
assume that native automation or an SDK guarantees the lifecycle.
