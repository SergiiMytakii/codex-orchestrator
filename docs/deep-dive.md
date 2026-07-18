# Runner architecture

## One public runtime

The package bin is `dist/src/v2/candidate-cli.js`; `candidate-cli` is only the historical source filename. It is the sole public CLI and routes `setup`, `doctor`, `status`, direct `run`, and serial `daemon` commands. The root package export exposes only V2 contracts.

The runtime is split into a policy core under `src/v2/` and a small package-owned adapter closure under `src/v2/adapters/`. No earlier runner implementation is shipped or executed.

`internal-workflow/manifest.json` is the sole workflow inventory. `npm run refresh:workflow` compiles it from the explicit source allowlist in `scripts/agent-auto-workflow-source.json` and the maintainer's `${CODEX_HOME:-$HOME/.codex}`. Each selected skill is copied with its accompanying files; declared shared routing resources and eval suites are copied separately. Every operation records its primary skill, dependency skills, shared resources, entrypoint, schema, profile, exact file closure, and authority policy. Its adapter must explicitly link those declared authorities or compilation fails.

Eval suites remain package-owned maintainer inputs. They are schema-checked, owner-bound, and included in the immutable generation, but excluded from operation snapshots so prompts cannot consume their expected or forbidden answers. `check:workflow` compares the compiled result with committed bytes, while `verify:workflow` validates the generated package offline without reading consumer or maintainer skills.

At runtime the Runner verifies the full package tree, publishes one immutable generation with a no-replace receipt, pins that receipt in the run record, and creates operation-scoped attempt snapshots only from the pin. Package updates and conflicting user skills cannot change an active run. Manifest V2 is used for newly compiled generations; the reader retains the exact V1 inventory contract so already-pinned V1 generations can resume without reinterpreting their workflow.

## Trust boundary

The Runner is trusted. It owns:

- issue discovery and authorization;
- worktree and durable state ownership;
- finite check execution;
- process launch, timeout, cancellation, and quiescence;
- Git commits, branches, pushes, pull requests, labels, and comments;
- mobile leases and proof artifact validation.

Implementation and proof Codex processes are untrusted workers. They receive bounded input, a dedicated tool home, a safe `PATH`, and only explicitly allowed non-secret tool environment values. Ordinary Codex execution and native Codex subagents may use the same user-owned Codex authentication and can read files available to the same local OS user; the containment certificate records this explicitly. GitHub, SSH, npm, and cloud publication credentials are scrubbed, and operations that require external authority remain finite Runner-owned actions.

This boundary prevents prompt content or repository code from receiving external publication authority. It does not claim OS-level secrecy from the current local user, so reports and artifacts are separately checked for credential/path disclosure. A child can implement, inspect, test, and report; the Runner performs authorized publication after validation.

## Configuration

`.codex-orchestrator/config.json` is an exact, versioned contract. Unknown keys and removed policy surfaces are rejected. It names one GitHub repository, five labels (`auto`, `running`, `blocked`, `review`, `waitingHuman`), one branch template, a serial polling interval, five implementation cycles, one Codex command contract, finite checks, one proof artifact directory, and deny lists.

The committed config contains policy, never live run state or credentials. Durable runtime state is stored beneath the configured state directory and the Runner's private home.

## `runIssue`

Direct runs and daemon-discovered runs call the same lifecycle:

1. Snapshot issue and repository identity.
2. Verify authorization and acquire fenced ownership.
3. Create or reconcile the issue worktree.
4. Persist a reviewed route. An `awaiting-user` route publishes one durable question, freezes only a current WRITE+ answer, restores running labels, and reruns triage in the same Run before implementation.
5. Run one implementation attempt and validate its structured report.
6. Inspect all tracked, staged, unstaged, untracked, and ignored denied-path changes.
7. Commit the validated implementation candidate locally.
8. Run configured checks and create a nominal `CheckedChange` bound to exact Git and content hashes.
9. Run Acceptance Proof against that binding.
10. Publish with durable intents and postcondition reconciliation.
11. Persist and return one typed terminal or resumable result.

Implementation findings return to the same worktree for at most five cycles. A malformed report gets one report-only repair; a clean transport disconnect gets one separate transport retry. Neither budget silently becomes another implementation cycle.

## Durable effects

Every external or non-idempotent operation uses intent-before-effect and confirmation-after-observation. On restart, the Runner inspects the durable intent and remote/local postcondition before deciding whether to retry. It does not infer failure merely from a lost response.

Atomic files use write, flush, rename, and directory synchronization where supported. Locks and leases carry fencing tokens and process/boot identity. Unknown ownership or inability to prove process-group absence is a safe halt, not permission to continue.

Workflow generation and attempt publication use hard-link claims, recovery chains, sealed file evidence, and ready receipts. Existing content is reused only after full path, mode, owner, size, and hash verification; active pre-generation V1 state fails closed while terminal V1 history remains readable.

## Checks and publication

Checks are configured finite commands executed by the Runner. Arbitrary agent-proposed shell commands do not become Runner authority. A check result is bound into `CheckedChange`; any later Git, index, tracked-content, untracked-content, worktree, or check-policy drift invalidates proof.

Only the Runner publishes. The implementation and proof processes cannot push, open a pull request, alter labels, or post comments. Publication is resumable and verifies exact repository, branch, commit, and remote postconditions.

## Acceptance Proof

Acceptance Proof receives the issue snapshot, frozen criteria, and nominal checked-change capability. It runs in a separate contained Codex process and writes only proof-owned artifacts.

The Runner validates:

- exact report schema and criterion IDs;
- artifact root containment, size, hash, UTF-8, and freshness;
- credentials in every text artifact;
- host identity and publication type for public artifacts;
- no product diff during proof;
- browser workflow and viewport evidence when visual;
- exact Android or iOS lease ownership for mobile evidence;
- unchanged checked-change freshness after proof.

Command output and static inspection may remain local and include machine paths. They are not public evidence. Screenshots and sanitized generated summaries may be publishable when their stricter checks pass.

## Setup and cutover

`setup` creates or verifies V2 config. `--prepare-labels` performs only the requested GitHub label preparation. `doctor` and `status` are read-only inspections.

Exact Config V1 is upgraded atomically by `setup configure` only after the shared run-owner fence and remote running claims are proven absent. Operational commands return `migration-required` until that upgrade completes.

Recognized earlier config is parsed only by the bounded cutover reader. `setup --fresh` acquires both ownership fences, proves no active old claims, saves immutable backup evidence, and publishes V2 config last. The old runtime never executes as part of this process.

## Live validation

Local validation is `npm run typecheck`, `npm test`, and `npm pack --dry-run --json`. Build removes `dist` first so deleted modules cannot leak into tests or tarballs.

The default live smoke packs and installs the exact candidate bytes in a temporary consumer and uses a scratch GitHub repository. Its compact release profile proves package installation, one normal default Codex run, browser evidence, and a safety-negative path. Cleanup verifies that run-owned issues, pull requests, branches, labels, and temporary directories are absent.
