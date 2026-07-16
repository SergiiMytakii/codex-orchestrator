---
title: "Codex Orchestrator v2 Spec 1: isolated core tracer"
created_at: "2026-07-16T19:07:00+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "This first slice defines credential containment and launches ordinary codex exec; a wrong environment can expose publication credentials across a trust boundary."
  - "The tracer creates durable run evidence and performs commit, push, draft-PR, comment, and label effects; wrong ordering can publish unproved work or duplicate effects."
review_outcome: "Waived"
review_verdict: "Shared-Codex-auth risk revision self-checked; independent re-review waived by user"
review_coverage: "Original Architecture/Execution and Failure/Contracts reviews remain recorded; the 2026-07-16 shared-auth revision and continued execution use user-authorized self-check only"
approved_content_sha256: "da5170aac93e0e8747ebff094801f12f7cdf1ad2ba1984cdc61956c19bb8c5ec"
source_plan_sha256: "e6dd64cdc7dbd3bec1c2734782b314443335822e8523591758230c71c6d2f6aa"
---

## 1. Execution Context

- **Goal:** Build the isolated V2 candidate and prove one eligible `agent:auto` issue can travel through implementation, configured checks, non-visual Acceptance Proof, runner-owned publication, and `agent:review` handoff using fake GitHub/Codex boundaries and real temporary Git repositories.
- **Source Material:** Approved plan `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-16/1655-agent-auto-v2-rewrite.md`, especially Sections 2.1-2.8 and slices 1-2; master spec `/Users/serhiimytakii/Projects/codex-orchestrator/docs/implementation-specs/2026-07-16/1906-agent-auto-v2-master.md`.
- **Approved Scope:** Plan slices 1-2 only: isolated `src/v2/` candidate, exact package-owned implementation/proof skills, generated report schemas, immutable per-attempt snapshot, ordinary `codex exec` process containment, clean V2 config/state rejection, candidate CLI/config/label surface, and one fake-backed review-ready tracer.
- **Out of Scope:** Multi-cycle rework; crash resume after external effects; complete publication reconciliation; browser/Android/iOS proof; Setup implementation; daemon polling; live-smoke migration; self-improvement adaptation; public bin/export switch; old runtime deletion; package publication.
- **Simplest Viable Path:** Keep the shipped V1 entrypoint untouched. Add a parallel V2 candidate under `src/v2/`, use the existing Git/GitHub interfaces and durable atomic-file primitive as concrete Adapters, and test the deep `RunIssue` and `AcceptanceProof` Modules through one end-to-end fake-backed tracer. Port no old coordinator implementation.
- **Primary Risk:** The candidate can appear green while shared Codex auth leaks into output/artifacts, non-Codex publication credentials reach tools, stale or structurally forged proof input is accepted, or publication starts before checks/proof and durable intent.

## 2. Preconditions And Evidence

- **Required Services / Env / Fixtures:** Node `v24.2.0`, npm `11.3.0`, Git, local Codex CLI `0.144.4`, existing user-owned Codex authentication, and macOS sandbox support for the containment feasibility canary. Unit/integration tests use temporary local/bare Git repositories plus deferred/rejecting GitHub/process/store fakes; no real GitHub repository is used.
- **Accepted Risk / Remaining Unknown:** The user explicitly accepts that ordinary `codex exec` root and native-child tool shells may read/use the same Codex auth as the parent and may read any local file available to the same macOS user. Slice 0 now proves the narrower enforceable boundary: those reads work without credential/path output, while GitHub/Git/npm/SSH/cloud identity and the production sentinel remain unavailable. Any non-Codex external-authority leak still blocks implementation.
- **Implementation checkout:** Create `/Users/serhiimytakii/Projects/codex-orchestrator-v2-agent-auto` on branch `codex/v2-agent-auto` from tag `v0.1.51` (`2ae87065fe70b61bd5ec09c51b2e380045f3d144`) exactly as specified by the master. Materialize and commit the plan/master/Spec 1 there before runtime edits.
- **Confirmed reuse targets:**
  - `src/fs/durable-atomic-file.ts:writeDurableAtomicFile` — reuse the concrete temp-write/fsync/rename/parent-fsync primitive.
  - `src/git/worktree.ts:GitWorktreeManager` — reuse concrete worktree/change-set/commit operations only; V2 policy stays in `RunIssue`.
  - `src/github/issues.ts:GitHubIssueAdapter` and `InMemoryGitHubIssueAdapter` — reuse transport contracts/fakes, not issue-selection policy.
  - `src/github/pull-requests.ts:GitHubPullRequestAdapter` and `InMemoryGitHubPullRequestAdapter` — reuse transport contracts/fakes, not publication policy.
  - `src/runner/scoped-auto-command.ts`, `agent-attempt.ts`, and `acceptance-proof.ts` at reference commit `0c876cb153c53f1bee5b08535406285d4c9899d6` — behavioral oracles only; inspect with `git -C /Users/serhiimytakii/Projects/codex-orchestrator show 0c876cb:<path>` and do not import them from `src/v2/`.
  - `test/package-consumer.test.ts`, `test/package-tarball.test.ts`, and `test/scoped-auto-command.test.ts` exist only in the `0c876cb` reference checkout, not base tag `v0.1.51`; inspect them with the same `git show 0c876cb:<path>` pattern. V2 receives separate tests in the implementation worktree.
- **Confirmed commands:** `npm run typecheck`, `npm test`, `npm pack --dry-run --json --ignore-scripts`, `git diff --check`, `codex --version`, and the new `npm run test:v2-containment` defined below.
- **Protected Paths / Rejected Approaches:** Do not edit/delete the reference checkout, existing V1 runtime/tests, `runtime-skills/`, bridge files, `src/cli.ts`, `src/index.ts`, current package exports/bin, setup code, live-smoke script, or self-improvement files. Do not add app-server, imported skill graph, provider registry, target-copied skills, package auth home/login, postinstall, config migration, compatibility reader, or path/text proof heuristics.

## 3. Ownership And Exact Interfaces

`src/v2/run-issue.ts` is the only issue lifecycle/publication policy owner. `src/v2/acceptance-proof.ts` is the only proof policy/artifact owner. Dependencies are composed once by `src/v2/runtime.ts`; call inputs contain no Adapter/platform callbacks.

```ts
runIssue({ targetRoot, issueNumber }): Promise<
  | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string }
  | { status: 'not-eligible'; reason: string; evidencePath: string }
  | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; resumable: boolean; evidencePath: string }
  | { status: 'transport-failed'; resumable: boolean; evidencePath: string }
  | { status: 'cancelled'; evidencePath: string }
  | { status: 'internal-error'; evidencePath: string }
>

proveChange({ proofId, issue, frozenCriteria, checkedChange }): Promise<
  | { status: 'passed'; receipt: ProofReceipt }
  | { status: 'needs-rework'; findings: string[]; receipt: ProofReceipt }
  | { status: 'external-block'; blocker: ExternalBlocker; receipt: ProofReceipt }
  | { status: 'transport-failed'; resumable: boolean; receipt: ProofReceipt }
  | { status: 'cancelled'; receipt: ProofReceipt }
  | { status: 'internal-error'; receipt: ProofReceipt }
>
```

```ts
interface IssueSnapshot {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN';
  labels: string[];
}

interface FrozenCriterion {
  id: string;
  order: number;
  source: 'explicit' | 'fallback';
  text: string;
}

interface ExternalBlocker {
  kind: 'credential' | 'tool' | 'service' | 'product-decision';
  summary: string;
  attempted: string[];
}
```

`IssueSnapshot.labels` is sorted/unique. Before implementation, `RunIssue` scans the issue body's first case-insensitive Markdown heading `Acceptance Criteria`, takes list items (`-`, `*`, `- [ ]`, or `- [x]`) until the next heading, trims checkbox/list syntax, removes empty/duplicate text while preserving first order, and emits `ac-001`, `ac-002`, ... . If none exist, it emits exactly `{ id: 'fallback-001', order: 1, source: 'fallback', text: title + '\n\n' + body }`. The frozen array and its canonical digest never change during the run.

- `src/v2/checked-change.ts` owns the nominal `CheckedChange` brand and one capability-pair constructor. `RunIssue` receives only `mint`; `AcceptanceProof` receives only `verifyAndRead`. Raw objects cannot satisfy the type and neither Module imports the other's Implementation.
- `src/v2/implementation-report.ts` is the sole owner of the implementation-agent TypeScript type, runtime validator, output-schema generator, repair diagnostics, and compact skill excerpt.
- `src/v2/proof-report.ts` is the equivalent sole owner for the proof-agent report. Skill prose contains no independent field definition.
- `ProofReceipt` contains only sanitized summary data, stable publishable evidence references/hashes, and an opaque local evidence ID. No raw report/artifact path, lease, platform route, or repair history crosses to `RunIssue`.
- The V2 run store accepts caller-supplied records and atomically persists them; it does not select lifecycle transitions or publication effects. Spec 1 needs only the single-run happy path and generation-safe write primitive; retry/reconciliation policy belongs to Spec 2.
- **Deletion test:** Removing `RunIssue` would scatter lifecycle/publication ordering across runtime/CLI/Adapters; removing `AcceptanceProof` would scatter proof classification/artifact policy; removing the checked-change capability would require a structural cast or cross-Module Implementation import. Other new helpers must remain direct leaf utilities; delete any pass-through wrapper found during implementation.

### 3.1 Canonical Encoding And Limits

- `canonicalJson(value)` emits UTF-8 JSON with object keys sorted by UTF-8 byte order, arrays kept in input order, no insignificant whitespace, JSON escaping from `JSON.stringify`, finite decimal integers only, and no `undefined`, non-finite number, duplicate key, or unknown key. SHA-256 digests below are lowercase hex over those exact bytes.
- Agent report files are at most 1 MiB; any string is at most 16 KiB; summaries/descriptions are at most 4 KiB; arrays are at most 256 entries; relative paths are normalized POSIX paths with no empty, absolute, `.` or `..` segment. Violations are malformed reports, not truncated input.
- Every report/record validator is strict: required keys are present, optional keys are explicitly named, and every unknown key fails.

### 3.2 Exact Candidate Config, Labels, And Eligibility

```ts
interface AgentAutoConfigV1 {
  schema: 'codex-orchestrator.agent-auto';
  version: 1;
  github: {
    owner: string;
    repo: string;
    baseBranch: string;
    labels: {
      auto: { name: string; color: string; description: string };
      running: { name: string; color: string; description: string };
      blocked: { name: string; color: string; description: string };
      review: { name: string; color: string; description: string };
    };
  };
  runner: {
    workspaceRoot: string;
    stateDir: string;
    branchTemplate: 'codex/issue-${issueNumber}';
    pollIntervalSeconds: number;
    maxCycles: 5;
  };
  codex: {
    command: string;
    requiredVersion: '0.144.4';
    timeoutMs: number;
    idleTimeoutMs: number;
    toolNetwork: 'deny';
  };
  checks: Record<string, string>;
  proof: { artifactDir: string };
  deny: { readPaths: string[]; commands: string[] };
}
```

- All integers are positive safe integers; owner/repo/base branch/label fields and check names/commands are non-empty; `workspaceRoot`, `stateDir`, and `proof.artifactDir` are normalized repository-relative paths; deny paths are canonical absolute paths or normalized repository-relative paths; deny commands are canonical executable paths. No defaults are applied by the runtime reader.
- Candidate command vocabulary is exactly `setup`, `doctor`, `status`, `run`, and `daemon`; candidate status vocabulary is the `runIssue` union; default label names in test fixtures are exactly `agent:auto`, `agent:running`, `agent:blocked`, and `agent:review`. There is no plan-auto/child/manual/graph/profile/auth/skill-runtime field or command.
- Spec 1 eligibility is exact: issue exists, is `OPEN`, contains the configured auto label, contains none of running/blocked/review, and has no existing open PR for the deterministic branch. `runId` is the lowercase output of `crypto.randomUUID()`. The claim comment body is exactly two lines with no third line: `<!-- codex-orchestrator:run:<runId>:claim -->` then `codex-orchestrator claimed #<issueNumber> for branch <branchName>`. The marker reader enumerates all issue comments, treats only an exact first line matching `^<!-- codex-orchestrator:run:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):claim -->$` as a marker, and accepts the current run only when exactly one such comment has the exact second line, current run/issue/branch, and author association `OWNER`, `MEMBER`, or `COLLABORATOR`. After durable claim intent, claim retains auto, adds running, and posts that comment. Before agent start and every publication effect, authorization requires OPEN+auto+running plus that accepted current-run marker; zero current markers, duplicate current markers, malformed same-run lines, untrusted current marker, conflicting same-run body, or any other run marker while running is present becomes durable `blocked(kind: safety, resumable: true)`. Review handoff removes auto/running/blocked and adds review only after the handoff comment succeeds.

### 3.3 Exact Report And Proof Handoff Contracts

```ts
interface ImplementationReportV1 {
  version: 1;
  status: 'completed' | 'external-block';
  summary: string;
  changedFiles: string[];
  residualRisks: string[];
  blocker?: { kind: 'credential' | 'tool' | 'service' | 'product-decision'; summary: string; attempted: string[] };
}

interface ProofReportV1 {
  version: 1;
  status: 'passed' | 'needs-rework' | 'external-block';
  decision: { mode: 'non-visual' | 'visual'; targets: Array<'browser' | 'android' | 'ios'> };
  criteria: Array<{
    id: string;
    status: 'passed' | 'failed' | 'unknown';
    confidence: 'high' | 'medium' | 'low';
    surfaces: Array<'non-visual' | 'browser' | 'android' | 'ios'>;
    evidenceRefs: string[];
    analysis: string;
  }>;
  checks: Array<{ id: string; command: string; status: 'passed' | 'failed'; summary: string; outputSha256: string }>;
  artifacts: Array<{
    id: string;
    kind: 'command-output' | 'static-inspection' | 'generated-file' | 'screenshot';
    relativePath: string;
    sha256: string;
    publishable: boolean;
    description: string;
  }>;
  findings: string[];
  residualRisks: string[];
  blocker?: { kind: 'credential' | 'tool' | 'service' | 'product-decision'; summary: string; attempted: string[] };
}

interface ProofReceipt {
  proofId: string;
  bindingSha256: string;
  summary: string;
  publishableEvidence: Array<{ ref: string; kind: 'screenshot' | 'summary'; sha256: string; description: string }>;
  localEvidenceId: string;
}
```

- Conditional validation is exact: implementation `completed` forbids blocker and requires at least one normalized changed file; `external-block` requires blocker. Proof `passed` requires all criteria passed/high, empty findings/blocker, and evidence for every criterion/surface; `needs-rework` requires non-empty findings and forbids blocker; `external-block` requires blocker. Spec 1 proof pass is `mode: non-visual`, `targets: []`, and every surface is `non-visual`; platform values are schema-compatible but not executable until later specs.
- Malformed implementation/proof report maps to `internal-error`; implementation external block maps to `blocked(external)`; proof external block maps to `blocked(external)`; proof transport/cancel/internal outcomes map one-to-one. Configured-check non-pass maps in the non-public Spec 1 candidate to public `internal-error`, with durable evidence code `check-rework-loop-not-yet-implemented`; proof `needs-rework` maps to public `internal-error`, with durable evidence code `proof-rework-loop-not-yet-implemented`. Callers inspect only `evidencePath`, not internal codes. Both are durable non-success outcomes tested through `runIssue`; Spec 2 must replace these temporary candidate mappings before any public cutover. Neither is called blocked, exhausted, or review-ready.

### 3.4 Exact Checked Change Binding

The hidden `CheckedChangePayloadV1` is:

```ts
interface CheckedChangePayloadV1 {
  version: 1;
  canonicalRepository: string;
  runId: string;
  issueNumber: number;
  cycle: 1;
  baseSha: string;
  headSha: string;
  indexTreeSha: string;
  trackedContentSha256: string;
  untrackedContentSha256: string;
  worktreeIdentity: string;
  changedFiles: string[];
  checks: Array<{ id: string; command: string; status: 'passed'; outputSha256: string }>;
  checkPolicySha256: string;
  packageVersion: string;
  proofSchemaVersion: 1;
}
```

`CheckedChange` carries this payload behind a module-private nominal brand. `checkedChangeSha256` is SHA-256 of its canonical JSON. `proofBindingSha256` is SHA-256 of canonical JSON `{ proofId, canonicalRepository, runId, issueNumber, cycle, frozenCriteriaSha256, issueSnapshotSha256, checkedChangeSha256, packageVersion, proofSchemaVersion, checkPolicySha256 }`. Reuse requires byte-identical binding and current HEAD/index/tracked/untracked/worktree/check-policy values before process launch and before accepting pass.

### 3.5 Exact Run And Proof Persistence Capabilities

```ts
type Lifecycle = 'claimed' | 'implementing' | 'checking' | 'proving' | 'publishing' | 'safe-halt' | 'review-ready' | 'blocked' | 'transport-failed' | 'cancelled' | 'internal-error';
type PublicationIntent =
  | { kind: 'claim-labels'; issueNumber: number; expected: string[] }
  | { kind: 'commit'; parentSha: string; treeSha: string; message: string }
  | { kind: 'push'; branch: string; sha: string }
  | { kind: 'pr'; owner: string; repo: string; head: string; base: string; issueNumber: number; marker: string }
  | { kind: 'comment'; issueNumber: number; marker: string; bodySha256: string }
  | { kind: 'labels'; issueNumber: number; expected: string[] };

interface RunRecordV1 {
  runId: string;
  issueNumber: number;
  canonicalRepository: string;
  baseSha: string;
  branchName: string;
  worktreePath: string;
  lifecycle: Lifecycle;
  cycle: 1;
  reportRepairs: 0;
  packageVersion: string;
  skillHashes: Record<string, string>;
  process?: {
    pid: number;
    processGroupId: number;
    startedAt: string;
    baseline: {
      headSha: string;
      indexTreeSha: string;
      trackedContentSha256: string;
      untrackedContentSha256: string;
      worktreeIdentity: string;
    };
  };
  checks: Array<{ id: string; command: string; status: 'passed' | 'failed'; outputSha256: string }>;
  checkedChangeSha256?: string;
  proofId?: string;
  proofReceipt?: ProofReceipt;
  intent?: PublicationIntent;
  outcomeEvidenceId?: string;
  terminalOutcome?:
    | { status: 'review-ready'; pullRequestUrl: string; evidencePath: string }
    | { status: 'blocked'; kind: 'external' | 'safety' | 'exhausted'; resumable: boolean; evidencePath: string }
    | { status: 'transport-failed'; resumable: boolean; evidencePath: string }
    | { status: 'cancelled'; evidencePath: string }
    | { status: 'internal-error'; code: string; evidencePath: string };
  createdAt: string;
  updatedAt: string;
}

interface RunStateFileV1 { schema: 'codex-orchestrator.agent-auto-state'; version: 1; generation: number; runs: RunRecordV1[] }
interface ProofStateV1 {
  schema: 'codex-orchestrator.acceptance-proof-state';
  version: 1;
  generation: number;
  proofId: string;
  bindingSha256: string;
  status: 'prepared' | 'running' | 'passed' | 'needs-rework' | 'external-block' | 'transport-failed' | 'cancelled' | 'internal-error';
  attempts: Array<{ attemptId: string; status: 'prepared' | 'running' | 'terminal'; reportSha256?: string }>;
  receipt?: ProofReceipt;
  updatedAt: string;
}
```

- `orchestratorHome` is `resolve(process.env.CODEX_ORCHESTRATOR_HOME ?? join(homedir(), '.codex-orchestrator'))`. `canonicalRepository` is `owner.toLowerCase() + '/' + repo.toLowerCase()` after strict GitHub owner/repo validation, and `repoKey` is lowercase SHA-256 over its UTF-8 bytes. Run state path is `join(targetRoot, config.runner.stateDir, 'v2', 'run-state.json')`. Proof state path is `join(orchestratorHome, 'v2', repoKey, 'proofs', proofId, 'state.json')`. Attempt snapshot root is `join(orchestratorHome, 'v2', repoKey, 'runs', runId, 'attempts', attemptId, 'snapshot')`.
- `RunRecordWriter.compareAndSwap(expectedGeneration, nextFile)` is available only to `RunIssue`; `ProofRecordWriter.compareAndSwap(proofId, expectedBinding, mutation)` is available only to `AcceptanceProof` and its accepted schema has no lifecycle/cycle/counter/publication field. Both are built over one private atomic-file mechanic; stale generation/binding fails without overwrite.
- First creation is CAS, not an exception: absent state has expected generation `0` and creates generation `1`; existing generation `N` requires expected `N` and writes `N + 1`. Proof creation follows the same rule and additionally requires its supplied `proofId`/binding. Any missing parent directory is created durably under the owning lock; an absent file is never interpreted as a pre-existing successful run/proof.
- Each state file has adjacent `<name>.lock` strict JSON `{ version: 1, token: string, host: string, pid: number, acquiredAt: string }`, acquired by `open('wx')`. Spec 1 waits at most 5 seconds for a same-host live owner, blocks on foreign/ambiguous/stale ownership without reclaim, and removes the lock only after token equality. Stale-owner recovery belongs to Spec 2. Under lock, CAS rereads generation/binding before writing. If an exception occurs after rename may have committed, reread: exact expected next bytes/generation means committed; prior bytes mean not committed; any third state is `internal-error` and never overwritten.
- `RunIssue` first performs one side-effect-free strict config read solely to derive `canonicalRepository`, `repoKey`, and `configSha256`; it reads no run state and calls no GitHub/Git/agent Adapter. It then acquires the host-global owner lock `join(orchestratorHome, 'v2', 'owners', repoKey + '.lock')` by `open('wx')`. Its strict record is `{ version: 1, token: string, canonicalRepository: string, host: string, bootId: string, pid: number, acquiredAt: string }`. Under that lock it immediately rereads strict config and requires byte-identical `configSha256` and repository identity before any state/GitHub/Git/agent operation; mismatch releases the token-matched lock and returns `internal-error` evidence `config-changed-during-owner-acquire`. A same-host/same-boot live owner is waited for at most 5 seconds; dead, ambiguous, foreign-host, or foreign-boot ownership is a pre-claim durable safety block and is not reclaimed in Spec 1. The lock is removed only after token equality and only after all process descendants, streams, report reads, store writes, and external-effect Promises have settled. This serializes different clones of the same repository; the adjacent file locks serialize individual CAS operations.
- Record validation is lifecycle-dependent: `implementing` requires the process baseline while a process is/was owned; `checking` requires a settled process and check rows accumulated so far; `proving` requires all configured checks passed plus `checkedChangeSha256` and `proofId`; `publishing` requires a passed `proofReceipt`; `safe-halt` requires retained PID/PGID/baseline evidence and has no `terminalOutcome`; a terminal lifecycle requires matching `terminalOutcome`, no live process, and no locally unsettled Promise. `review-ready` additionally requires no `intent` and a passed receipt. Non-terminal records may retain an intent until that exact effect is durably completed; terminal records may retain an intent only for non-resumable `transport-failed`, where remote delivery is unknown despite the local Promise having rejected. `not-eligible` is written as a separate pre-claim evidence artifact and does not create a run record.
- Claim is two separately recoverable effects, never one assumed-atomic mutation: persist `claim-labels`, await retaining auto plus adding running, clear it by CAS; then persist the ordinary `comment` intent containing the exact claim marker/body hash, await the trusted claim comment, and clear it by CAS. Only then may the authorization reread permit agent start. The same one-intent/one-effect rule applies to commit, push, PR, handoff comment, and terminal labels.

### 3.6 Exact Containment Certificate

`src/v2/containment.ts` owns the one schema/validator used by the canary and runtime. The canary writes `join(orchestratorHome, 'v2', 'certifications', 'containment-codex-0.144.4.json')` only after every mandatory root and native-child probe confirms the accepted shared Codex-auth/host-read contract and denies every tested non-Codex external-authority capability:

```ts
interface ContainmentProbeResultV2 {
  parentAuthReadable: true;
  parentAuthUsable: true;
  externalCredentialsUsable: false;
  deniedSecretReadable: true;
  productionSentinelExecuted: false;
}

interface ContainmentCertificateV2 {
  schema: 'codex-orchestrator.containment';
  version: 2;
  codexVersion: '0.144.4';
  platform: 'darwin';
  packageVersion: string;
  argvPolicySha256: string;
  root: ContainmentProbeResultV2;
  nativeChild: ContainmentProbeResultV2;
  completedAt: string;
  resultSha256: string;
}
```

The native-child probe is mandatory: unavailable, unstarted, unattempted, malformed, or broader in external authority than root fails the canary. `resultSha256` binds the strict canonical result before that field is added. On failure, the canary deletes any stale certificate matching its package/Codex/argv-policy tuple and writes no green replacement. Before issue fetch/claim, candidate runtime requires strict parse, current package version, exact Codex version/platform, certificate version `2`, `argvPolicySha256` of the production argv/environment builder, literal `true` for shared Codex-auth and denied-host-file readability, literal `false` for external credential and production fields, and recomputed `resultSha256`; otherwise it returns a pre-claim safety block. The certificate contains no auth/secret path or credential value. The accepted risks are explicit: skill prose forbids copying or printing shared Codex auth/local secrets, but the OS does not enforce read isolation.

### 3.7 Exact Supervised Process Seam

`src/v2/codex-process.ts` owns one V2-local, non-exported test seam because the existing final-result-only `ProcessExecutor` cannot prove process-group quiescence:

```ts
interface SpawnSpec { file: string; args: string[]; cwd: string; env: Record<string, string>; stdin: string }
interface SupervisedChild {
  pid: number;
  processGroupId: number;
  lastActivityAt(): number;
  writeStdinAndClose(value: string): Promise<void>;
  waitForExit(): Promise<{ exitCode: number | null; signal: string | null }>;
  terminateGroup(signal: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  waitForGroupAbsent(timeoutMs: number): Promise<void>;
  waitForStreamsClosed(): Promise<{ stdout: Buffer; stderr: Buffer; truncated: boolean }>;
}
type SpawnSupervisedProcess = (spec: SpawnSpec) => Promise<SupervisedChild>;
```

Root self-check found that the original private seam could not implement the required resettable idle timeout because it exposed no stdout/stderr activity observation. `lastActivityAt()` is the minimal read-only correction; it adds no application capability or public Interface surface and keeps output bytes inside the supervised child.

`src/v2/runtime.ts` owns one root `AbortController`, binds it to candidate-command `SIGINT`/`SIGTERM`, and passes the same signal through `RunIssue`, `AcceptanceProof`, and every `CodexProcess.run(input, signal)` call; tests inject and abort the controller directly. `CodexProcess` owns process cancellation after the signal fires. Stdout and stderr are each capped at 1 MiB while still draining; the report file uses the Section 3.1 1 MiB cap; timeout and idle timeout come from strict config. On abort/timeout it sends SIGTERM, waits 5 seconds, sends SIGKILL if needed, then waits at most 10 seconds for group absence and stream closure. The production implementation uses Node `spawn` with `detached: true`, bounded stream collectors, and process-group signaling; tests inject the seam. Every normal exit, spawn failure, timeout, idle timeout, and cancellation awaits exit, descendant/group absence, stream closure, and atomic report read before returning. If normal parent exit leaves a descendant, the owner terminates the group and proves absence; no lifecycle/proof/publication/return or lock release precedes that barrier.

### 3.8 Exact Async Failure Mapping

Spec 1 performs no automatic retry. Every row below is awaited, persisted, and tested; after the listed outcome no later publication effect may begin.

| Failure or rejection | Public result | Durable rule |
| --- | --- | --- |
| Owner lock, strict parse, or pre-effect CAS/store failure | `internal-error`; evidence code `state-write-failed` | No external effect starts; retain/read the last confirmed generation. |
| Codex spawn/transport failure after confirmed quiescence and byte-identical baseline | `transport-failed(resumable: true)` | Persist terminal evidence and clear process ownership. |
| Codex process quiescence cannot be confirmed after SIGTERM, SIGKILL, and the bounded absence check | No public result yet | CAS-persist non-terminal `safe-halt` with PID/PGID/baseline, keep the owner lock, start no other work, and continue absence checks without resolving `runIssue`; only confirmed absence may transition to durable `transport-failed(resumable: false)` and release/return. |
| Configured check executor rejects | `internal-error`; evidence code `configured-check-execution-failed` | Record failed check evidence; do not mint `CheckedChange`. |
| Configured check returns non-pass | `internal-error`; evidence code `check-rework-loop-not-yet-implemented` | Temporary candidate outcome; Spec 2 replaces it. |
| Proof returns `needs-rework` | `internal-error`; evidence code `proof-rework-loop-not-yet-implemented` | Temporary candidate outcome; Spec 2 replaces it. |
| Proof dependency rejects or returns untyped/malformed failure | `internal-error`; evidence code `acceptance-proof-internal-failure` | Preserve proof evidence if valid; no publication. |
| Local worktree/commit effect rejects before any remote invocation | `internal-error`; evidence code `local-git-effect-failed` | Persist terminal evidence; no push/PR/comment/label. |
| Issue read/revalidation rejects before invoking the next effect | `transport-failed(resumable: true)` | Only when no previous effect has unknown delivery. |
| Claim, push, PR, comment, or label Promise rejects after invocation | `transport-failed(resumable: false)` | Delivery is unknown; retain the exact pre-effect intent, start no later effect, and do not retry in Spec 1. |
| Post-effect completion CAS rejects | `transport-failed(resumable: false)` | Retain the pre-effect intent because durable completion is unknown; no later effect. |
| Caller aborts | `cancelled` | Return only after process/effect/store quiescence and durable terminal evidence. |

## 4. Write Scope Summary

- `src/v2/config.ts` — Create; exact V2 config/state schema IDs and strict clean-reader validation for fields required by the tracer. No Legacy interpretation.
- `src/v2/implementation-report.ts` — Create; implementation report owner and generated JSON schema.
- `src/v2/proof-report.ts` — Create; proof report owner, generated JSON schema, criterion/surface validation, and sanitized receipt projection.
- `src/v2/checked-change.ts` — Create; nominal checked-change capability and canonical binding digest.
- `src/v2/runtime-assets.ts` — Create; package-relative skill resolution and private immutable attempt snapshot publication/verification.
- `src/v2/containment.ts` — Create; shared containment argv-policy hash plus strict certificate schema/validator used by both canary and runtime.
- `src/v2/codex-process.ts` — Create; ordinary `codex exec` argv, isolated tool HOME, allowlisted child environment, process supervision, bounded output, and typed terminal result.
- `src/v2/atomic-store.ts` — Create; shared lock/read/strict-parse/generation-CAS/temp-fsync/rename/parent-fsync mechanics only; deletion is justified by two capability-specific stores.
- `src/v2/run-store.ts` — Create; strict V2 run-record capability for `RunIssue`, with no lifecycle policy.
- `src/v2/proof-store.ts` — Create; strict proof-only capability keyed/bound by `proofId`, with no run fields.
- `src/v2/acceptance-proof.ts` — Create; deep proof Module, non-visual proof execution, binding/freshness validation, proof-only local evidence, and `ProofReceipt`.
- `src/v2/run-issue.ts` — Create; deep issue Module and the single fake-backed lifecycle/publication tracer.
- `src/v2/runtime.ts` — Create; composition root for concrete Git/GitHub/process/store/runtime-asset dependencies and checked-change capability split.
- `src/v2/cli-contract.ts` — Create; final candidate command/status/exit vocabulary only. It is not wired to the package bin before Spec 8.
- `internal-skills/agent-auto/SKILL.md` — Create; exact implementation mission, authority limits, report schema path, and no publication.
- `internal-skills/acceptance-proof/SKILL.md` — Create; independent non-visual proof mission for Spec 1. It must not reference browser/Android/iOS files until those files are packaged by later specs.
- `test/v2-config-contract.test.ts` — Create; clean schema acceptance and Legacy/experimental/public-surface rejection.
- `test/v2-report-contracts.test.ts` — Create; generated-schema/runtime-validator parity and `ProofReceipt` shape.
- `test/v2-acceptance-proof.test.ts` — Create; `proveChange` binding/freshness, proof-only persistence, criterion/artifact/diff validation, deterministic reuse, and exhaustive private proof outcomes. This separate Module-level test is required because report-schema parity alone cannot prove the deep `AcceptanceProof` Interface.
- `test/v2-runtime-assets.test.ts` — Create; exact package resolution, immutable snapshot, symlink/extra-file/mode/hash/corruption/update races.
- `test/v2-codex-process.test.ts` — Create; exact argv/environment/process terminal classification with fake process execution.
- `test/v2-run-store.test.ts` — Create; strict state, generation CAS, concurrency, ambiguous rename/fsync recovery, and capability-isolation tests.
- `test/v2-run-issue.test.ts` — Create; public-Interface tracer with temp Git and in-memory GitHub/Codex boundaries.
- `test/v2-package-consumer.test.ts` — Create; tarball install/update ownership, conflicting local skills, packed asset/schema resolution, and candidate-surface assertions.
- `test/v2-containment.canary.ts` — Create; explicit real-Codex containment canary not included in ordinary `npm test` glob.
- `package.json` — Update only `files` to include `internal-skills` and scripts to compile/run the explicit containment canary; keep bin/exports and old prepack pipeline unchanged.
- `package-lock.json` — Update only if npm mechanically records the package-script/files metadata; no dependency changes are authorized.
- This implementation-worktree copy of Spec 1 — Update checklist/ledger/review evidence during execution.

No additional runtime file is authorized without first recording why one of these owners cannot contain the behavior and applying the deletion test.

## 5. Risk Controls

- **Source of Truth:** `RunIssue` owns lifecycle/publication; `AcceptanceProof` owns proof; each report contract file owns its schema; the package directory owns internal skill bytes; `run-store.ts` owns durability mechanics only.
- **Safety Constraints:** After Slice 0 proves feasibility, `CodexProcess` invokes `codex exec --strict-config --ignore-user-config --ignore-rules --sandbox workspace-write --output-schema <snapshot-schema> --output-last-message <attempt-report> -c approval_policy=\"never\" -c skills.include_instructions=false -c web_search=\"disabled\" -c features.apps=false -c sandbox_workspace_write.network_access=false -c shell_environment_policy.inherit=none`, followed by explicit `shell_environment_policy.set.<KEY>=<VALUE>` overrides for isolated tool `HOME`, fixed safe `PATH`, attempt `TMPDIR`, locale, and empty tombstones for the exact GitHub/Git/SSH/npm/cloud credential keys exercised by the canary. It does not disable native multi-agent features; root and any native child must remain under identical sandbox/environment/credential constraints. It supplies the exact snapshot skill path in the static prompt, no MCP/plugin/app configuration, and no authenticated external-write tool.
- **Credential Constraints:** The Codex parent plus root/native-child tool shells may read/use the same user-owned Codex authentication and any user-readable host file under the user's explicit risk acceptance. Tool subprocesses otherwise receive an isolated package-owned `HOME`, fixed safe `PATH`, locale/temp variables, minimum attempt paths, and explicit empty credential tombstones. They do not inherit usable `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, Git credential helpers/askpass, `SSH_AUTH_SOCK`, npm auth/config, or cloud credentials. No canary, report, log, artifact, commit, or PR content may contain credential bytes or auth/secret paths.
- **Network Constraint:** Tool network is disabled for this spec. Target network opt-in is deferred until a later spec can prove the same credential scrub; the tracer requires no network inside Codex tools.
- **Publication Constraints:** The implementation/proof agents cannot run Git publication. `RunIssue` rereads OPEN+auto+run-marker authorization before agent start and before commit, push, draft PR, handoff comment, and terminal labels. It performs configured checks and obtains `passed` proof before it CAS-persists each lifecycle/intent and awaits the corresponding effect in order. Spec 1 proves ordering/settlement and deterministic failure without retry; complete crash reconciliation is Spec 2.
- **Package Constraints:** `internal-skills/` is read from the installed package and privately snapshotted per attempt. No target skill copy, manifest graph, import script, activation command, or postinstall mutation is introduced.
- **Early Review Gates:** Independent containment/process, lifecycle/publication, cleanup, and final code reviews are waived by the user's explicit 2026-07-16 instruction to self-check and continue. The root executor still runs the named focused tests, architecture scan, full validation, and checklist reconciliation at the same boundaries; this waiver is not an independent approval.
- **Final Handoff Requirements:** Final response must include the exact tracer contract, containment canary result, package snapshot proof, report/interface invariants, early review findings/fixes, commands run, skipped live gates, residual risks deferred to Spec 2, and files grouped by Module/Adapter/test/package asset.

## 6. Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| V2 accepts only exact clean config/state schema IDs and exposes no plan-auto/tree/graph/auth/skill-runtime command or label field. | Legacy policy or removed product surfaces silently enter the new runtime. | RED `test/v2-config-contract.test.ts` exact-key and candidate CLI/label snapshots plus strict run/proof state cases in `test/v2-run-store.test.ts` | verified |
| Installed package bytes, not local same-name skills, own both agent workflows and generated schemas. | Local skills alter behavior or package updates leave stale target workflow copies. | RED packed-consumer conflicting-skill test in `test/v2-package-consumer.test.ts` | verified |
| Every attempt executes one private symlink-free, exact-file, exact-mode, hash-verified snapshot; package changes cannot mutate active bytes. | Update/crash/symlink races change instructions after evidence is recorded. | RED corruption/update/race matrix in `test/v2-runtime-assets.test.ts` | verified |
| Generated output schema and runtime validation come from the same TypeScript owner for each report. | Skill prose, schema file, and parser accept different report shapes. | RED parity fixtures in `test/v2-report-contracts.test.ts` | verified |
| Raw objects cannot construct `CheckedChange`; `proofId` binds exact issue/criteria/change/package/schema/check policy and stale worktree input fails before proof effects. | Old or forged proof is accepted for new code. | RED compile/runtime capability, binding-mismatch, and pre/post freshness cases in `test/v2-acceptance-proof.test.ts` | verified |
| `ProofReceipt` exposes no raw local paths/platform/lease/repair fields and only sanitized publishable references may reach publication. | `RunIssue` must understand proof storage or leaks local/secret evidence. | RED Interface-shape and redaction fixture in `test/v2-report-contracts.test.ts` | verified |
| Root and native-child tool shells can read/use shared Codex auth and user-readable host files without emitting credential/path material, but cannot use runner/GitHub/npm/SSH/cloud credentials or launch the production sentinel. | Accepted local-read exposure silently expands into publication authority or secret exfiltration. | Pre-runtime boolean-only `npm run test:v2-containment` feasibility canary; any external capability leak blocks the design | verified — V2 certificate GREEN for root and native child |
| Every Codex terminal path reaches process-group/descendant absence plus stream/report quiescence before lifecycle/proof/publication/return/lock release. | An orphan mutates a supposedly settled worktree or races validation. | RED detached-descendant tests in `test/v2-codex-process.test.ts` | verified |
| Stale/concurrent run/proof generations cannot overwrite committed state; pre/post-rename/fsync ambiguity is reread and classified deterministically. | Durable state is lost or two owners both believe they committed. | RED CAS/crash matrix in `test/v2-run-store.test.ts` | verified |
| `claimed -> implementing -> checking -> proving -> publishing -> review-ready` and each intent are durably CAS-persisted before the next owner/effect. | A terminal snapshot hides skipped stages or publication without durable intent. | RED gated-transition event trace in `test/v2-run-issue.test.ts` | verified |
| OPEN+auto+run-marker authorization is reread before agent start and before commit, push, PR, comment, and terminal labels. | Revoked work continues to mutate Git/GitHub. | RED mutable-issue revocation matrix in `test/v2-run-issue.test.ts` | verified |
| Every store/process/check/proof/Git/GitHub Promise is awaited; rejection prevents later effects and review-ready. | Fire-and-forget code passes immediate fakes and publishes false success. | RED deferred/rejecting Adapter matrix in `test/v2-run-issue.test.ts` | verified |
| `RunIssue` performs no real claim/publication mutation until the separately recorded containment feasibility gate is green, and no commit/push/PR/comment/review label before checks plus passed proof. | Unverified work is claimed/published or the candidate is used despite failed containment. | Feasibility artifact check plus RED event-trace assertions in `test/v2-run-issue.test.ts` | verified |
| One fake-backed eligible issue yields one runner commit, one push, one draft PR, one handoff comment, `agent:review`, and durable evidence through the public Interface. | Layer tests pass while the real Module flow is disconnected. | RED temp-Git/in-memory-Adapter tracer in `test/v2-run-issue.test.ts` | verified |
| npm pack/install/update adds package-owned V2 assets but causes no orchestrator-induced config/state/ignore/package-script/GitHub mutation in the consumer. | Package updates unexpectedly reconfigure projects or external state. | RED before/after ownership fixture in `test/v2-package-consumer.test.ts` | verified |

## 7. Execution Slices

### Progress Discipline

- [x] Update this checklist and ledger in the implementation worktree as work completes.
- [x] Keep each slice RED -> GREEN -> local refactor; do not batch all tests before implementation.
- [x] Stop if repo reality contradicts an exact target, command, capability, or source-of-truth rule.
- [x] Do not widen a stable Interface or add an Adapter registry to make a test easier.
- [x] Do not run a real GitHub issue, push, or PR; all publication in this spec uses a local bare remote and in-memory GitHub Adapters.

### Preflight Gate — Ordinary-exec containment feasibility

- [x] **Objective:** Prove the revised ordinary-`codex exec` direction records accepted shared Codex-auth/host-file readability while denying every external credential and production capability before any later V2 runtime code is implemented.
- [x] Create only `src/v2/containment.ts`, `test/v2-containment.canary.ts`, its `test:v2-containment` package script, and the temporary fixture files it owns. The harness invokes real Codex `0.144.4` with the exact strict-config/sandbox/network/shell-environment settings from Section 5 and a strict boolean-only output schema. No other `src/v2/` runtime file may be created before this gate passes.
- [x] The root agent and one native child must each attempt without printing values: read the exact parent `CODEX_HOME` auth source; run `CODEX_HOME=<parent> codex login status`; inspect/use GH/Git/npm/SSH/cloud identity; read one separate host-file fixture outside `CODEX_HOME`; and execute one harmless denied sentinel whose only possible effect is creating a marker in the canary temp root.
- [x] Passing requires parent/root/native-child Codex auth and the host-read fixture are readable, every external credential/production probe reports inaccessible/unusable, no sentinel marker exists, output contains no credential/path content, and all process descendants are absent. The harness records only CLI/package version, booleans, timestamps, and output hash, then atomically writes the Section 3.6 V2 certificate. The production runtime validates that certificate before issue fetch/claim.
- **Accepted Risk Resolution:** The earlier all-false certificate failed because root/native-child shells could read/use parent Codex auth and could read the separate host-file fixture. The user explicitly accepted both local-read risks, required self-check instead of independent review, and authorized a V2 certificate that records them as `true`. The old failure remains historical RED evidence, not an active blocker.
- [x] **Hard stop:** If shared Codex auth/host reads are unavailable to a mandatory probe, any external credential/production probe succeeds, a native child has broader external authority, strict config rejects the planned controls, credential/path material appears in output, or the result cannot distinguish inaccessible from unattempted, mark Spec 1 execution blocked. None of these stop conditions occurred; no issue or external publication surface was touched.

### Slice 1 — Isolated package contract

- [x] **Objective:** The packed candidate owns exact internal skill/report-schema bytes and rejects removed/Legacy surface before any issue flow exists.
- [x] **Test/Proof First:** Add failing config, report parity, package tarball, conflicting local-skill, and candidate CLI/label snapshot tests named in ledger rows 1-4.
- [x] Create strict `src/v2/config.ts`, both report owners, `src/v2/cli-contract.ts`, and the two minimal package skills.
- [x] Add `internal-skills` to `package.json.files`; do not change bin/exports/prepack or consumer project files.
- [x] **Exit Gate:** `npm run typecheck`; focused compiled tests for `v2-config-contract`, `v2-report-contracts`, and `v2-package-consumer`; `npm pack --dry-run --json --ignore-scripts` inventory includes both skills and generated-schema code and retains the old bin.

### Slice 2 — Immutable attempt snapshot

- [x] **Objective:** Resolve exact installed skill/schema bytes and atomically publish one private immutable snapshot consumed by an attempt.
- [x] **Test/Proof First:** Add failing tests for resolve/update/spawn race, temp-tree crash, fsync-before-rename failure, rename-before-return, partial/corrupt destination, extra file, mode/ownership drift, and symlink substitution at every level.
- [x] Implement `src/v2/runtime-assets.ts` directly over package-relative resolution and durable filesystem primitives; no shared cache, graph, provider, or target copy.
- [x] Persist package version, exact file list/hashes/modes, snapshot root, and generated schema hash in attempt evidence.
- [x] **Exit Gate:** Focused `v2-runtime-assets` tests pass and prove active snapshot bytes remain unchanged when the installed fixture package is replaced.

### Slice 3 — Contained ordinary Codex process

- [x] **Objective:** Produce exact ordinary-`codex exec` argv/environment/process results without ambient tool authority.
- [x] **Test/Proof First:** Add failing fake-process tests for exact flags, isolated HOME/env allowlist, absent credentials/config, local-skill/app/web-search suppression without native-subagent suppression, bounded stdout/stderr, spawn/exit/timeout/idle/cancel classifications, detached descendants after normal exit and timeout/cancel, process-group termination, and output/report flush before return.
- [x] Implement the exact V2-local supervised-process seam from Section 3.7 inside `src/v2/codex-process.ts`; do not reuse or widen the final-result-only old `ProcessExecutor`, and do not add a transport/provider framework.
- [x] Keep `test/v2-containment.canary.ts` byte-for-byte aligned with the production argv/environment builder and rerun its root/native-child parent-auth and capability probes.
- [x] Add `test:v2-containment` as `npm run build --silent && node dist/test/v2-containment.canary.js`.
- [x] **Exit Gate:** Focused `v2-codex-process` tests and `npm run test:v2-containment` pass with Codex CLI `0.144.4`; any exposed authority invalidates ordinary-exec and blocks further implementation.

### Review Checkpoint 1 — Containment

- [x] Run the user-authorized root self-check on Slices 1-3 before implementing the issue tracer; independent `$code-review` is waived.
- [x] Continue only when self-check findings are fixed, focused tests and the real canary rerun green, and no raw credential value or auth/secret path was written to logs/artifacts.

### Review Focus

- Trust-boundary enforcement, env/HOME inheritance, Git credential helpers, symlink/path replacement, schema drift, process descendants after timeout/cancel, output flush ordering, and speculative abstraction.

### Slice 4 — Checked change and non-visual proof tracer

- [x] **Objective:** A checked worktree becomes one nominal bound `CheckedChange`, receives an independent non-visual proof, and returns a sanitized `ProofReceipt`.
- [x] **Test/Proof First:** Add failing nominal-type, binding mismatch, stale HEAD/index/tracked/untracked/check-policy, raw-path rejection, criterion-ID coverage, malformed report, and forbidden proof-diff tests through `AcceptanceProof.proveChange`.
- [x] Implement `src/v2/checked-change.ts`, `src/v2/proof-store.ts`, and `src/v2/acceptance-proof.ts`; compose only `ProofRecordWriter` into proof, keep run fields unrepresentable, and expose no platform parameter.
- [x] In this spec only `passed` is needed for the end-to-end tracer, but every union outcome must be representable and contract-tested without untyped exceptions. Rework/retry orchestration remains Spec 2.
- [x] **Exit Gate:** Focused proof/report tests pass; repeating identical binding is deterministic, mismatched binding fails before process launch, and the receipt contains no raw storage field.

### Slice 5 — Single issue review-ready tracer

- [x] **Objective:** One fake-backed eligible issue completes the entire final Module path to review-ready.
- [x] **Test/Proof First:** Add a failing event-traced public `runIssue` test that asserts exact ordering: containment artifact -> initial authorization -> durable claimed -> claim effect -> durable implementing -> authorization -> agent -> quiescence -> durable checking -> deferred check pass -> durable proving -> checked change -> deferred proof pass -> durable publishing plus intent before each authorization/effect -> commit -> push -> PR -> handoff comment -> terminal labels -> durable review-ready -> return.
- [x] Implement `src/v2/atomic-store.ts`, `src/v2/run-store.ts`, `src/v2/run-issue.ts`, and `src/v2/runtime.ts`; reuse concrete existing Git/GitHub leaf Adapters but import no old coordinator/rework/proof implementation.
- [x] Add `test/v2-run-store.test.ts` RED/GREEN coverage for strict parse, stale generation, concurrent writers, malformed state, temp/fsync/rename/parent-fsync failure, deterministic reread, token-safe lock release, and inability of proof capability to encode run fields.
- [x] The tracer uses a temporary source repo plus bare origin, mutable/deferred/rejecting GitHub issue/PR Adapters, deferred store/process/check/proof/Git effects, one configured check, and deterministic clock/IDs. Before resolving each Promise assert no later call/terminal return; after rejection assert exact durable non-success and no later effect. Full crash reconciliation remains Spec 2.
- [x] Add public-Interface terminal cases for not eligible, revoked authorization -> blocked safety, agent-authored commit -> blocked safety, proof external block -> blocked external, process transport/cancel/internal mappings, malformed state/config -> internal-error, unchanged/no-file implementation -> internal-error, configured-check non-pass -> `internal-error` with durable evidence code `check-rework-loop-not-yet-implemented`, and proof needs-rework -> `internal-error` with durable evidence code `proof-rework-loop-not-yet-implemented`.
- [x] Add the full Section 3.8 deferred/rejecting matrix. For each pre-effect rejection assert no effect begins; for each post-invocation rejection assert `transport-failed(resumable: false)`, retained intent, no implicit retry, and no later effect. For cancellation, withhold process/store/effect settlement independently and prove `runIssue` does not return or release the owner lock early. For unconfirmed process absence, prove durable `safe-halt`, no publication/return/lock release while absent-check is unresolved, then confirmed absence -> terminal non-resumable transport failure.
- [x] **Exit Gate:** `test/v2-run-issue.test.ts` passes end-to-end and no direct Adapter/platform/storage dependency appears in `runIssue(...)` or `proveChange(...)` call arguments.

### Review Checkpoint 2 — Lifecycle And Publication

- [x] Run the user-authorized root self-check on Slices 4-5 before packed reconciliation; independent `$code-review` is waived.
- [x] Continue only after self-check findings in durable transition/intent ordering, authorization freshness, awaited effects, capability separation, proof binding, and false review-ready outcomes are fixed and focused store/proof/tracer tests rerun green.

### Review Focus 2

- Stale generation, skipped durable transition, publication without persisted intent, authorization revocation between effects, unresolved/rejected Promise fan-out, proof/run capability crossing, stale checked change, and any terminal result emitted before durable evidence.

### Slice 6 — Packed candidate reconciliation

- [ ] **Objective:** Prove the V2 candidate works from packed bytes while the installed public bin still points to V1 until final cutover.
- [ ] **Test/Proof First:** Extend the packed-consumer fixture to install version A, record project/config/state/ignore/scripts/GitHub markers, update to fixture version B with changed skill hash, and fail if package-owned changes escape npm-managed package/lock/node_modules paths.
- [ ] Verify packed runtime resolution uses version B for a new cycle while a materialized version-A attempt snapshot remains byte-identical.
- [ ] Assert the tarball contains `dist/src/v2/**` and `internal-skills/**`, current bin remains `dist/src/cli.js`, and no V2 setup/postinstall/activation mutation occurs.
- [ ] **Exit Gate:** Focused packed-consumer/tarball tests, `npm run typecheck`, full `npm test`, `npm pack --dry-run --json --ignore-scripts`, and `git diff --check` pass.

## 8. Halt Conditions

- [ ] Stop if the dedicated branch/worktree or base tag differs from the precondition; do not reuse or reset an existing conflicting branch/worktree.
- [ ] Stop if ordinary `codex exec` cannot provide the accepted shared Codex-auth/host-read behavior while withholding any tested runner/GitHub/npm/SSH/cloud authority or production command from tool subprocesses.
- [ ] Safe-halt if a spawned process group cannot be proven absent after bounded termination attempts: retain durable PID/PGID/baseline and repository owner lock, publish nothing, and keep `runIssue` unresolved until absence is externally or subsequently confirmed. Do not misreport this as a completed terminal outcome.
- [ ] Stop if a V2 Module needs to import old coordinator/graph/app-server/migration code rather than a proven leaf Adapter/utility.
- [ ] Stop if proof can pass after the checked change/binding/worktree changed, or if `ProofReceipt` must expose a raw local path.
- [ ] Stop if the tracer cannot prove checks/proof before publication or requires real GitHub mutation.

## 9. Validation And Done Criteria

- [ ] **Lint/Format:** `git diff --check`.
- [ ] **Typecheck:** `npm run typecheck`.
- [ ] **Tests:** focused RED/GREEN reruns during each slice, then full `npm test`.
- [ ] **Architecture Check:** `rg -n "src/(runner|codex)/(scoped-auto-command|agent-attempt|acceptance-proof-loop|skill-runtime|app-server)|runtime-skills" src/v2 test/v2-*.test.ts test/v2-containment.canary.ts` returns no V2 production import; evidence-only comments/test strings must be reviewed manually.
- [ ] **Package Proof:** `npm pack --dry-run --json --ignore-scripts` and packed-consumer install/update tests.
- [ ] **Containment Proof:** `npm run test:v2-containment` with Codex CLI `0.144.4`.
- [x] **Live/Manual Validation:** No real GitHub/mobile/live-smoke run in this spec.
- [ ] **Behavior Proof:** One fake-backed public `runIssue` returns `review-ready` with exactly one local runner commit/push, one in-memory draft PR/handoff, passed checks/proof, and durable evidence.
- [ ] **Cleanup/Final Review:** Independent cleanup and final code review are user-waived. Perform one root self-check over the settled diff, integrate safe simplifications, and rerun affected/full validation; report the review waiver explicitly.
- [ ] **Final Reconciliation:** Every checklist/ledger row is green, blocked with evidence, or explicitly not applicable; no unchecked work is described as complete.
- [ ] **Final Handoff Requirements:** Report Contract implemented, High-risk checkpoints, Main invariants proved, Code-review findings, Fixes after review, Validation, Skipped checks, Residual risks, and Files by role. State explicitly that recovery, real platform proof, Setup, live smoke, and public cutover remain future specs.

## 10. Defect Closure Notes

- **Review Summary:** Two independent Full reviews plus same-session affected-lens Closure approved every repaired Architecture/Execution and Failure/Contracts defect.
- [x] Every stable Defect Ledger ID is `verified`, `blocked` with a concrete reason, or explicitly accepted by the user.
- **Open Defects:** None.

| ID | Repair | Status |
| --- | --- | --- |
| `S1-DELEGATION-001` | Removed native-subagent suppression; root/native children share identical containment and canary obligations. | verified |
| `S1-CONTAIN-002` | Added a pre-runtime, boolean-only feasibility gate plus exact durable certificate for actual parent auth, accepted host-file readability, denied external capabilities, output-path hygiene, and production sentinel; failure outside the accepted risks blocks ordinary exec. | verified |
| `S1-DTO-003` | Added exact issue/criteria/implementation/proof/receipt/checked-change contracts, limits, canonical encoding, conditional validation, and outcome mapping. | verified |
| `S1-CONFIG-004` | Added exact strict config, labels, candidate commands, eligibility, and handoff predicates. | verified |
| `S1-PROOF-STORE-005` | Added exact orchestrator home/repository key, absent-state CAS, separate proof-only schema/writer/path, and composition rule; run fields are unrepresentable. | verified |
| `S1-PROCESS-006` | Added a V2-local supervised-process seam with root cancellation ownership, PID/PGID, descendants, bounded streams, termination deadlines, and quiescence tests. | verified |
| `S1-REVIEW-007` | Fixed checkpoint wording and added separate containment plus lifecycle/publication checkpoints. | verified |
| `S1-OUTCOME-008` | Preserved the public Interface while defining temporary check/proof-rework codes only in durable evidence. | verified |
| `S1-ASYNC-009` | Added exact deferred/rejecting store/process/check/proof/Git/GitHub mappings, unknown-delivery behavior, safe-halt, and no-later-effect assertions. | verified |
| `S1-EVIDENCE-010` | Marked post-tag fixture evidence reference-only with exact `git show 0c876cb:<path>` access and implementation-worktree-relative authority copies. | verified |
| `S1-SKILL-011` | Removed references to not-yet-packaged browser/mobile procedures. | verified |
| `S1-STORE-012` | Added side-effect-free identity read, host-global owner lock, config reread, exact first-write CAS/ambiguous-commit rules, and crash/concurrency tests. | verified |
| `S1-LIFECYCLE-013` | Added durable lifecycle/intent CAS, process/check/terminal evidence, and non-terminal safe-halt before every next owner/effect. | verified |
| `S1-AUTH-014` | Added exact trusted UUID-v4 claim marker and mutable authorization rereads before agent and every publication effect. | verified |
| `S1-PROCESS-ACTIVITY-016` | Root self-check added the missing private activity clock required for a resettable idle timeout, moved production listeners before fast child exit/output, typed stream-quiescence failure as safe-halt evidence, and kept source-package ownership outside snapshot ownership policy. | verified |
| `S1-LIFECYCLE-017` | Lifecycle self-check added direct-parent symlink rejection before state IO, proof-process safe-halt propagation, root-signal settlement barriers for check/proof/store/effect phases, post-effect CAS ambiguity mapping, strict owner-lock/config/Codex-version gates, and default contained process composition. | verified |

### 10.1 Implementation Execution State

- **Execution Outcome:** Containment preflight, Slices 1-5, and both root self-check checkpoints are GREEN under the user's explicit shared-Codex-auth and host-read risk acceptance; Slice 6 is active.
- **Authority Artifact:** This revised Spec 1 is the execution authority; independent artifact/code reviews are waived, so root self-check and executable proof are the only revision gates.
- **TDD Activation:** The old all-false contract is historical RED. The revised V2 certificate is GREEN, so Slice 1 now proceeds one behavior proof at a time with RED before production implementation.
- **Implementation Reviews:** Waived by the user on 2026-07-16. Review Checkpoints 1/2 and final cleanup/code review are replaced by root self-check plus the same focused/full validation commands; outcome remains `Waived`, not independently approved.
- **Accepted Execution Risk:** `S1-EXEC-CONTAIN-015` — root/native-child tool shells may read/use user-owned Codex auth and any file readable by the current macOS user. Authority: two explicit user decisions on 2026-07-16. Scope excludes credential/path output and every GitHub/npm/SSH/cloud/production capability.
- **Downstream Checklist:** The revised containment canary and V2 certificate passed. Slice 1 is eligible; later slices remain gated by their predecessor exits.
- **Checkpoint Commits:** `b0c9e53` is the required docs-only bootstrap; `4ac31aa` records the revised GREEN containment contract; `7c5f7ee` records Slice 1 package contracts; `ab6c2e2` records Slice 2 immutable runtime assets; `0b03200` records Slice 3 supervised Codex processes; `61cbb43` records Slice 4 bound acceptance proof. No RED implementation or failed validation state was committed.
- **Root Self-Check Evidence:** Focused Slices 1-3 suite `26/26`, real Codex containment canary, strict certificate/argv-policy validation, architecture import scan, `git diff --check`, and parent-auth-path diff scan all passed. Independent review remains waived.
- **Slice 4 Self-Check Evidence:** Focused proof/report suite `11/11`, compile-time nominal branding, runtime anti-forgery, exact binding mismatch before process launch, pre/post freshness checks, proof-only persistence, artifact/diff confinement, architecture import scan, `npm run typecheck`, and `git diff --check` all passed.
- **Slices 4-5 Root Self-Check Evidence:** V2 suite `54/54`, full repository suite `764/764`, public temp-Git/bare-origin review-ready tracer, deferred/rejecting store/process/check/proof/Git/GitHub matrix, implementation/proof safe-halt, cancellation settlement barriers, strict CAS/crash/symlink store matrix, architecture import scan, `npm run typecheck`, and `git diff --check` passed. Independent review remains waived.

## 11. Final Action

After saving the final reviewed file, report:

Spec Status: Ready / Blocked
Saved Path: docs/implementation-specs/2026-07-16/1907-agent-auto-v2-core-tracer.md
Execution Model: Single-Agent
Review Outcome: Approved / Blocked / Waived
Adapter Verdict: Approved / Needs Work / Rejected / Not run
Review Profile: high
Review Passes: total; full/closure/fresh counts
Review Coverage: mandatory lenses covered / Not reviewed
Open Defects: stable IDs or None
Validation Gates: Local / Live / Tests
Blockers: unresolved blockers or None
