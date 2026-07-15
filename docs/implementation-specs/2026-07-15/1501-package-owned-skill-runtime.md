---
title: "Package-owned isolated skill runtime implementation"
created_at: "2026-07-15T15:01:15+03:00"
source_type: "plan"
source_plan: "/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-15/1330-package-owned-skill-runtime.md"
source_issues:
  - "None"
status: "ready"
execution_model: "single-agent"
spec_mode: "full"
review_profile: "high"
review_reasons:
  - "The approved plan changes authentication isolation, process authority, durable state schemas, migration, concurrency, retry and recovery behavior."
  - "The change replaces the Codex transport and workflow source across six runtime call sites and two separately released package generations."
review_outcome: "Approved"
review_verdict: "Approved"
approved_content_sha256: "d2deb8724b408405b05b170787fa7198af2fafb81de5438d63c739097d1422cc"
review_coverage: "Prior high-risk maker loop retained; user-requested standalone Full plus two same-session Closures covered all mandatory lenses and verified every stable defect"
---

## 1. Execution Context

- **Goal:** Make the installed npm package the only reusable workflow owner, inject only manifest-selected package skills through isolated Codex app-server sessions, and migrate consumers from prompt/config v1 through a bridge-fenced config/state v2 rollout.
- **Source Material:** Approved plan at `/Users/serhiimytakii/Projects/codex-orchestrator/docs/plans/2026-07-15/1330-package-owned-skill-runtime.md`; repository routing in `AGENTS.md` and `docs/agents/execution-routing.md`; runner ownership decision in `docs/adr/0001-runner-owned-loop-policy.md`.
- **Approved Scope:** Bridge activity fence and preparation command; package-owned runtime-skill bundle and importer; immutable bundle materialization; Runner-owned workflow graph and execution-policy caps; Codex app-server transport and package-owned runtime home/auth; state/config v2; staged migration and pre-claim preflight; cutover of all six Codex call sites; removal of runtime prompt ownership; tests and documentation.
- **Out of Scope:** Plugin marketplace distribution; synchronization with personal skills; target-selected skill names or paths; automatic bundle garbage collection; multi-host unattended migration; redesign of issue selection, publication, or Acceptance Proof semantics; live GitHub smoke; npm publication, release, push, or consumer rollout without separate authorization.
- **Simplest Viable Path:** Execute this spec as two separately resumed terminal phases, never one continuous diff. Phase A implements only the target activity fence, forward-compatible state-v2 envelope, `bridge-runtime.json`, and `setup --prepare-skill-runtime-v2`, runs bridge-only reviews/tests, and stops unconditionally. A separately authorized action must create/push the bridge release; at least one consumer must install it and write the canonical prepared generation. Phase B may begin only in a fresh resumed execution after the canonical artifact and its package hash are verified and copied into the structural manifest's accepted hash list, then adds the checked-in bundle, app-server adapter, graph/config v2, migrates every runtime call site, and removes legacy prompt execution. Keep `CodexCommandAdapter` as the compatibility facade and do not retain an exec fallback.
- **Primary Risk:** A partially migrated runner could claim work with ambiguous workflow provenance, widened tool authority, stale review budgets, copied personal auth/config, or a legacy daemon racing config migration.

## 2. Preconditions And Evidence

- **Required Services / Env / Fixtures:** Node/npm and Git for local tests. Runtime and the real local app-server contract suite require exactly Codex CLI `0.144.4`; another version returns `orchestrator-codex-version-mismatch` before issue selection. `test/fixtures/fake-responses-provider.ts` is the only local fake-provider fixture and captures the real app-server model-bound Responses request. No live AI provider is required. GitHub read access is required only for bridge preparation/drain proof; unavailable GitHub fails closed. Package auth uses app-server `account/read`/`account/login/start` or the stable app-server `CODEX_ACCESS_TOKEN` trusted-automation input. `CODEX_API_KEY` is rejected because official Codex docs limit it to `codex exec`; `OPENAI_API_KEY` is not accepted as implicit app-server auth in this release.
- **Initial Import Source:** The exact skill allowlist is `to-spec`, `to-tickets`, `tickets-breakdown-review`, `triage`, `implementation-spec-maker`, `implementation-spec-review`, `spec-implementer`, `tickets-orchestrator`, `tdd`, `cleanup-review`, `code-review`, `small-task-implementer`, `ui-evidence-proof`, `domain-modeling`, `grilling`, and `improve-codebase-architecture` — 16 entries. The one-time maintainer import reads only those directories, their transitively referenced files beneath `/Users/serhiimytakii/.codex/skills`, and transitively referenced shared policy beneath `/Users/serhiimytakii/.codex/docs/agents`. The importer receives `--source-root /Users/serhiimytakii/.codex`, rejects every non-allowlisted read, and pins actual source bytes in `source-snapshot.json`.
- **Helper Source Blobs:** Because the reviewed Python references are deleted from the current `.codex` working tree, the importer reads them with `git -C /Users/serhiimytakii/.codex show`: `8ff0f17f73713b9cee3e7d1da35ebeb06898c6d5:skills/_shared/scripts/review_context.py` at SHA-256 `785ed1df91af2b5e4010c6b04f9cb560fbaf150980565faf9119d7ff195e7c3f`; `8ff0f17f73713b9cee3e7d1da35ebeb06898c6d5:skills/_shared/scripts/detect_test_command.py` at `28b4244a7077c2cd4b143e1e341cac11dc6992ba79017f37cb704bf2eb3a4c33`; `1c8a637009401fadd2b05bad0eb39ea2e8ecf5e8:scripts/artifact_review_fingerprint.py` at `cd092e22f67c6dcc0fc90e2d6885aac5c86f94c32a735313335050dff5f8bd59`; and `1c8a637009401fadd2b05bad0eb39ea2e8ecf5e8:scripts/test_artifact_review_fingerprint.py` at `2b8658d0d798bc9beeea9a19e602e765e0fba80add09237681e838332d631260`. Any missing/hash-mismatched blob blocks import. Personal skills are authorized only as this explicit read-only maintainer source; build, prepack, setup, doctor, and runtime never read `.codex`.
- **Pinned Tool-Catalog Evidence:** On 2026-07-15 the installed `codex-cli 0.144.4` app-server was started against a loopback failing fake Responses endpoint with `features.apps=false`, `features.multi_agent=false`, `features.multi_agent_v2=false`, `skills.include_instructions=false`, `web_search="disabled"`, `approvalPolicy: "never"`, `dynamicTools: []`, empty environments/MCP, and isolated HOME/CODEX_HOME. Independent `read-only` and `workspace-write` turns produced the same six-entry projection and hashes pinned in §2.2. The implementation fixture must reproduce those hashes before its real-CLI test starts; captured output cannot replace the pinned constants.
- **Supported Bridge Platforms:** `darwin` and `linux`. Linux identity uses `/proc/sys/kernel/random/boot_id`, `/proc/<pid>/status` UID, `/proc/<pid>/stat` start time, `/proc/<pid>/exe`, and `/proc/<pid>/cmdline`. Darwin identity uses `sysctl -n kern.boottime`, `ps -p <pid> -o uid=,lstart=,command=`, and `lsof -a -p <pid> -d txt -Fn` for executable identity. Missing tools, malformed/ambiguous output, Windows, and every other platform return `bridge-process-introspection-unsupported` before generation write.
- **V1 Drain Evidence:** Preparation must prove all three sources empty while holding the exclusive fence: no matching live/ambiguous daemon process; no nonterminal/claimed v1 `RunnerStateStore` record; and no open GitHub issue carrying the configured running label. Any open running-labeled issue blocks regardless of comment age because `claimIssue()` writes the label/comment before local attempt state. GitHub read failure returns `bridge-github-drain-unavailable`; stale claims must be reconciled/cancelled with the bridge package before preparation, never guessed away.
- **Current Dirty State Precondition:** Before implementation run `git status --short --branch`. At spec creation time `docs/plans/2026-07-15/` is untracked user work. Preserve it and every unrelated change; stage only explicit implementation paths when a commit is authorized.
- **Blocking Unknowns:** None for Phase A local implementation. Phase B is intentionally unavailable until a separately authorized released bridge has produced the canonical `prepared-generation.json` at one consumer and its `bridgePackageHash` is entered in structural `bundle.json.acceptedBridgePackageHashes`; missing/mismatched evidence stops before Slice 1. Publication/rollout remains an explicit execution hold, not implicit authorization.
- **Confirmed Current Targets:**
  - `package.json` publishes `dist/src` and `prompts`; scripts provide `build`, `typecheck`, `test`, `prepack`, and `smoke:live`, but no lint or architecture-check script.
  - `src/codex/command-adapter.ts` exports `CodexCommandRunInput`, `CodexCommandRunResult`, and `CodexCommandAdapter.run(...)`; it currently executes `codex exec`, preserves ambient `CODEX_HOME`, and passes prompt text through stdin.
  - `src/config/schema.ts` owns exact config parsing and `CodexOrchestratorConfig.version: 1`; `src/setup/project-config.ts` builds/merges v1; `.codex-orchestrator/config.json` contains `codex.adapter: "codex-cli"` and target-owned `workflows`.
  - `src/runner/local-state.ts` owns exact `RunnerStateFile.version: 1`; `src/runner/mission-state-store.ts` owns exact `MissionStateSnapshot.version: 1`.
  - `src/runner/mission-coordinator-lock.ts` already proves PID/boot-nonce/token stale-owner rules; `src/runner/mission-process-executor.ts` already owns detached process-group termination primitives.
  - The six current `codexAdapter.run(...)` sites are `src/runner/plan-auto-command.ts`, `src/runner/agent-attempt.ts`, `src/runner/acceptance-proof-runner.ts`, the completion-report repair path in `src/runner/local-execution-session.ts`, the proof-evidence repair path in the same file, and `src/runner/fresh-context-review.ts`.
  - `src/setup/prompt-sync.ts`, `src/setup/workflows.ts`, `src/setup/setup-command.ts`, `src/runner/doctor-command.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, and `src/runner/prompt.ts` currently make target prompt files part of runtime execution.
- **Confirmed Commands:**
  - Focused tests use the exact compiled test-file commands listed in each slice; do not substitute a different test family.
  - Full local gates are `npm run typecheck`, `npm test`, `npm pack --dry-run --json`, and `git diff --check`.
  - No lint or architecture-check command exists; use `git diff --check`, source-of-truth boundary review, `npm run typecheck`, and `npm test`.
  - `npm run smoke:live` mutates real GitHub state and is forbidden without separate explicit authorization.
- **Protected Paths / Rejected Approaches:** Outside the explicit one-time allowlisted import above, do not read, print, copy, or edit `.env`, `.env.*`, personal `${CODEX_HOME:-$HOME/.codex}`, personal/global `AGENTS.md`, personal skills, plugin/app caches, or personal auth files. The importer may copy only declared skill/resource bytes into `runtime-skills/`; it may not copy auth, config, sessions, cache, plugins, apps, or global instructions. Do not retain `codex exec` as fallback. Do not interpolate issue/report/proof/review text into turn text. Do not let target config choose a skill path, widen a signed node policy, or grant model nodes external writes. Do not auto-delete content-addressed bundles. Do not migrate pre-fence or active/resumable/claimed v1 state. Do not publish, push, release, or run live smoke under this spec.

### 2.1 Exact New Module Boundaries

- `src/runner/target-activity-fence.ts` owns the target-scoped shared/exclusive activity generation used by bridge daemon lifetime, targeted claim, preparation, and v2 migration. It reuses PID/boot-nonce/token logic from `mission-coordinator-lock.ts`; deleting it would reintroduce setup-versus-daemon and claim-versus-migration races.
- `src/setup/skill-runtime-v2-preparation.ts` owns same-host process introspection and the prepared-generation artifact. It must not own general daemon execution or config migration.
- `src/skills/package-skill-bundle.ts` is the sole owner of manifest parsing, complete-file hashing, installed-package-relative resolution, atomic materialization, immutable snapshot verification, and provenance records. Deleting it would scatter bundle trust checks across setup, doctor, and runtime.
- `src/skills/package-skill-graph.ts` is the pure owner of operation lookup, graph-template expansion, execution-policy intersection, graph transitions, joins, checkpoints, and review budget accounting. It never starts Codex or mutates GitHub/worktrees. Deleting it would let call sites choose skills or transitions independently.
- `src/codex/execution-adapter.ts` contains only the stable `CodexExecutionAdapter` interface with exact `run`, `interruptTurn`, and `closeRun` operations defined in §2.2. The current need is the six call-site seam plus fake protocol testing and deterministic per-run process cleanup; it must not become a multi-adapter registry.
- `src/codex/app-server-client.ts` owns typed JSON-RPC initialize/request/notification/event correlation over stdio.
- `src/codex/app-server-process.ts` owns the per-run supervisor/process group, per-thread background-terminal cleanup, sibling-safe timeout handling, idempotent run close, shared-death fan-out, persisted-auth lease transitions, and orphan reconciliation by reusing `mission-process-executor.ts` primitives. `src/codex/app-server-supervisor.ts` is its package-owned Node launch gate: it cannot start Codex until the parent has fsynced the supervisor PID/PGID into the lease, proxies app-server stdio after release, and kills its group when the parent control pipe closes. This extra process exists only to close the spawn-before-PID-persist crash window.
- `src/codex/package-runtime-home.ts` owns `${CODEX_ORCHESTRATOR_HOME:-$HOME/.codex-orchestrator}/codex-home/v1`, account preflight/login, and package-home-only environment construction. It never reads or copies personal auth/config.
- `src/codex/command-adapter.ts` remains the public compatibility facade, implements `CodexExecutionAdapter`, and orchestrates the modules above. There is one runtime implementation: app-server.
- `src/runner/skill-runtime-preflight.ts` owns target-independent bundle/CLI/app-server/auth/config/state preflight and the post-worktree selected-node policy gate.
- `src/setup/skill-runtime-v2-migration.ts` owns backup, candidate config translation/validation, commit-point rename, and activity-generation reconciliation. It must not claim issues or start Codex.

### 2.2 Manifest, Graph, Adapter, And Durable Contracts

`runtime-skills/bundle.json` is the single operation owner. The importer and runtime parser reject unknown/missing keys. `files` covers every payload file except `bundle.json`; `source-snapshot.json`, `adaptation-map.json`, `adaptation-report.json`, result JSON Schemas, tools, fixtures, skills, operations, and shared resources are payload files.

```ts
type ReviewProfile = "simple" | "medium" | "high";
type WorktreeAccess = "read-only" | "write";
type WritableRootClass = "worktree" | "target-state" | "proof-artifacts";

interface RuntimeMcpToolPolicyV1 {
  server: string;
  tool: string;
  approval: "never";
}

interface RuntimeExecutionPolicyV1 {
  worktreeAccess: WorktreeAccess;
  sandboxMode: "read-only" | "workspace-write";
  writableRootClasses: WritableRootClass[];
  network: "deny" | "allow-listed";
  networkHosts: string[];
  mcpTools: RuntimeMcpToolPolicyV1[];
  approvalCeiling: "never";
  externalWrite: false;
  model: string | null;
  effort: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  timeoutMs: number;
  idleTimeoutMs: number;
}

interface RuntimeGraphNodeV1 {
  id: string;
  skill: string;
  additionalSkills: string[];
  contextArtifactKinds: string[];
  resultSchema: string;
  successors: Array<{
    when: "succeeded" | "blocked" | "route-small" | "route-spec-required" | "approved" | "needs-work" | "rejected";
    node: string;
  }>;
  executionPolicy: RuntimeExecutionPolicyV1;
}

interface RuntimeGraphV1 {
  id: string;
  entryNode: string;
  nodes: RuntimeGraphNodeV1[];
}

interface RuntimeGraphTemplateV1 {
  id: string;
  kind: "artifact-review" | "tickets-breakdown-review" | "checkpoint-review" | "cleanup-review" | "code-review";
  profile: ReviewProfile | null;
  maximumReviews: number;
  requiredFreshReviewers: number;
  expansionGraph: string;
}

interface RuntimeSkillBundleManifestV1 {
  version: 1;
  package: { name: "codex-orchestrator"; version: string };
  acceptedBridgePackageHashes: string[];
  sourceSnapshot: "source-snapshot.json";
  sourceFingerprint: string;
  adaptationMap: "adaptation-map.json";
  adaptationReport: "adaptation-report.json";
  bundleHash: string;
  files: Array<{ path: string; mode: number; size: number; sha256: string }>;
  skills: Record<string, { entry: string; files: string[]; references: string[] }>;
  operations: Record<string, { graph: string; entryNode: string }>;
  graphTemplates: Record<string, RuntimeGraphTemplateV1>;
  graphs: Record<string, RuntimeGraphV1>;
}

interface NodeControlEnvelopeV1 {
  version: 1;
  nodeId: string;
  outcome: "succeeded" | "blocked" | "route-small" | "route-spec-required" | "approved" | "needs-work" | "rejected";
  artifactRefs: string[];
  result: unknown;
}
```

Manifest rules:

- `files`, skill keys, operation keys, graph/template keys, node IDs, successors, `mcpTools`, and artifact kinds are sorted and duplicate-free. Every path is normalized POSIX UTF-8 NFC.
- Every `entry`, `reference`, `resultSchema`, graph node/edge/template, tool, report, and snapshot path resolves beneath `runtime-skills/`; symlinks, absolute paths, `..` escape, undeclared executables, and duplicate normalized paths are invalid.
- Every node's `NodeControlEnvelopeV1.result` is validated against its manifest-selected strict JSON Schema before `outcome` is mapped to a declared successor. The model never supplies a skill path, policy, template, budget, or arbitrary successor.
- Only `small-task-implementer` and `spec-implementer` nodes may use `worktreeAccess: "write"`, `sandboxMode: "workspace-write"`, or the `worktree` writable class. All nodes have `externalWrite: false` and `approvalCeiling: "never"`. Target/global policy may remove tools, network, writable classes, model, effort, or time; it cannot add or widen them. Interactive approval is outside this release because the unattended Runner has no user-response channel.
- Every initial-release node has `mcpTools: []`; bundle validation rejects a non-empty list. MCP catalog projection is provider/server-specific and is not admitted until a later reviewed bundle/config version pins its exact fixture.
- The package graph deliberately follows the approved source plan when it differs from the imported current global review policy. `artifact-review(simple)` is A Full plus up to two A Closures, maximum 3. `medium` is A Full plus up to three A Closures, maximum 4. `high` is parallel A Architecture/Execution Full and B Failure/Contracts Full; affected A/B Closures after one consolidated repair; mandatory fresh C integrator Full only after A/B closure; one C Closure only when C found defects; maximum 6 with C's slot reserved. `adaptation-map.json` names this approved-plan exception and fixtures prove no current-global two-review topology can leak into the package graph.
- `tickets-breakdown-review`, `checkpoint-review`, and `cleanup-review` use fresh reviewers independent from their producer/implementer. `code-review` expands independent A/B, join, bounded closure, and final aggregation. Successor edges do not exist until the required aggregate verdict is persisted.

`source-snapshot.json` contains sorted records `{ logicalPath, origin: "working-tree" | "git-blob", sourcePath, sourceRevision: string | null, mode, size, sha256 }`. Its `sourceFingerprint` is SHA-256 over UTF-8 `codex-orchestrator-runtime-source-v1\0` followed, for each record, by four-byte big-endian canonical-record-JSON length, RFC 8785 canonical JSON bytes, eight-byte big-endian content size, and exact source bytes. Working-tree records use `sourceRevision: null`; Git helper blobs use the exact revisions above. `bundle.json.sourceFingerprint` must equal this digest.

Canonical hashing uses SHA-256 over this exact byte framing:

1. UTF-8 bytes `codex-orchestrator-runtime-bundle-v1\0`.
2. Four-byte unsigned big-endian length plus RFC 8785 canonical JSON bytes of `bundle.json` with `bundleHash: ""`.
3. For each sorted payload file: four-byte path-byte length, path bytes, four-byte unsigned mode, eight-byte unsigned size, then exact file bytes.

The resulting lowercase hex digest is `bundleHash`. Per-file `sha256`, size, and mode are verified before whole-bundle hashing. The temp tree is complete, hash-verified, changed to directories `0555` and files `0444`/`0555` according to manifest executable mode, and fsynced before a no-overwrite atomic publish. A concurrent loser never mutates the destination; it removes only its own temp tree and re-verifies the winner. Crash leftovers use `".runtime-bundle-tmp-" + process.pid + "-" + nonce` and may be removed after proving they are not a manifest destination; this is temp cleanup, not bundle GC.

The stable adapter seam replaces prompt text with exact graph-node execution:

```ts
interface CodexExecutionRunInputV2 {
  targetRoot: string;
  worktreePath: string;
  config: CodexOrchestratorConfigV2;
  runId: string;
  issueNumber: number;
  sessionId: string;
  branchName: string;
  phase: CodexPhase;
  operationId: string;
  nodeId: string;
  attemptId: string;
  skillRuntime: SkillRuntimeRecordV2;
  manifestNode: RuntimeGraphNodeV1;
  targetPolicy: TargetExecutionPolicyV2;
  contextArtifactPath: string;
  reportPath: string;
  logPath: string;
  phaseEnv: Record<string, string>;
}

interface CodexExecutionRunResultV2 extends CodexCommandRunResult {
  status: "completed" | "failed" | "interrupted" | "timeout" | "idle-timeout" | "protocol-death" | "blocked";
  attemptId: string;
  processId?: number;
  processGroupId?: number;
  threadId?: string;
  turnId?: string;
  expectedToolCatalogHash: string;
  finalMessageHash?: string;
  recovery: "none" | "clean-retry" | "partial-continuation" | "partial-node-mutation";
}

interface CodexExecutionAdapter {
  run(input: CodexExecutionRunInputV2, signal?: AbortSignal): Promise<CodexExecutionRunResultV2>;
  interruptTurn(input: { runId: string; attemptId: string; threadId: string; turnId: string; reason: "cancelled" | "timeout" | "idle-timeout" }): Promise<void>;
  closeRun(input: { runId: string; reason: "completed" | "cancelled" | "failed" | "runner-shutdown" }): Promise<void>;
}
```

`run` never accepts `promptText`, `promptPath`, raw argv, arbitrary skill names, or model-selected policy. Every operation graph owner wraps all node dispatch in `try/finally { await adapter.closeRun({ runId, reason }) }`. After each `thread/start` and before its first `turn/start`, the client calls experimental `thread/backgroundTerminals/list` with exact `{ threadId }` and requires `{ data: [] }`; initialize sets `capabilities.experimentalApi: true`. A method-not-found, capability error, non-empty new-thread list, or malformed response blocks as `orchestrator-background-terminal-capability-missing` before model execution.

Abort of one node calls `interruptTurn` in this exact order: send `turn/interrupt` with `{ threadId, turnId }`; await its `{}` response and that turn's `turn/completed` with `status: "interrupted"`; call `thread/backgroundTerminals/clean` with `{ threadId }` and await `{}`; then call `thread/backgroundTerminals/list` and require `data: []`. Because every graph node owns a distinct thread, cleanup is scoped to the interrupted node and does not touch sibling threads. If terminal acknowledgement is absent after 10,000 ms, or clean/list fails, the node persists `turn-cleanup-unconfirmed` and is not retried or continued. With an active healthy sibling, the process stays alive only until siblings settle; without one, or after they settle, the whole process group is terminated and reconciled before return.

Every non-protocol-death terminal status uses the same `finalizeTurn` barrier, including ordinary `completed` and `failed`: retain streamed output/final message only in the execution's temporary log/report path; await `turn/completed`; call per-thread `backgroundTerminals/clean`; require the subsequent list to be empty; only then atomically accept the final report, set `atomicWriteComplete: true`, persist terminal/recovery state, emit the node artifact reference, and allow graph transition/retry/continuation/successor dispatch. Cleanup failure preserves raw evidence but marks the node `turn-cleanup-unconfirmed`; its report is not accepted and no successor starts. `protocol-death` cannot call thread cleanup, so its equivalent barrier is confirmed absence of the recorded supervisor process group before baseline reconciliation. Thus completed A cannot leave an asynchronous process running when B starts.

`closeRun` is idempotent. It atomically marks the run closing, runs the same interrupt -> terminal acknowledgement -> per-thread clean -> empty-list sequence for every active thread in parallel, waits up to 10,000 ms, terminates the whole process group only after no healthy sibling can continue or on protocol/process death, awaits stdio/process closure, and persists each affected execution terminal/recovery status. Unexpected shared-process death fans out `protocol-death` to every active execution; each logical node then applies its own unchanged-baseline/retry budget. Tests cover A timeout/cleanup while B completes, background terminal A absent before B settles, clean/list capability failure before turn, shared death with A/B recovery, runner exception before successor, repeated close, and lease release after forced termination.

Every `turn/start` sets `approvalPolicy: "never"`, omits `dynamicTools`, and can expose only manifest/target-intersected MCP tools whose per-tool approval is also `never`. Nevertheless the JSON-RPC client handles every 0.144.4 `ServerRequest` fail-closed so no request can hang: `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` return `{ decision: "decline" }`; legacy `execCommandApproval` and `applyPatchApproval` return `{ decision: "denied" }`; `item/tool/requestUserInput` returns `{ answers: {} }`; `mcpServer/elicitation/request` returns `{ action: "decline", content: null, _meta: null }`; `item/permissions/requestApproval` returns `{ permissions: {}, scope: "turn", strictAutoReview: false }`; and `item/tool/call` returns `{ contentItems: [], success: false }`. `account/chatgptAuthTokens/refresh`, `attestation/generate`, and `currentTime/read` return JSON-RPC error `-32001` with message `orchestrator-server-request-disabled`; an unknown method returns `-32601`. A request carrying a valid active `threadId` then interrupts/cleans only that thread and persists `unexpected-server-request:<method>` with no retry/continuation. A legacy, process-scoped, unknown, malformed, or uncorrelated request persists `unexpected-process-server-request:<method>`, idempotently closes all active threads, terminates/reconciles the process group, and blocks the run. Contract tests invoke `codex app-server generate-ts --experimental --out <temp>` for the pinned binary, enumerate its `ServerRequest` union, and fail when a method lacks a response and scope rule.

The expected catalog is an approved package fixture, not output learned from the test under evaluation. Add `runtime-skills/tool-catalogs/codex-0.144.4.json` with the full canonical projection `{ type, name, description, parameters, strict }` for each entry and these independently pinned entry hashes: `function:exec_command=7ecb0f4f51b3982e36be43a9d08daa05348d7dd5f70646231b1f0f9823f40ec3`, `function:request_user_input=0c8ecb27846caac4e678ccd9cca7de8d1ee8fd52d18d5f30c529048dd6940482`, `function:update_plan=ccfa481d2d3c51cb2b3b43c9336ca38ae8ea5581d2136d2838833feca357a939`, `function:view_image=5f77165b6665a58f62c7efa2df2d21dc8beac9c389270666e88768ace1a868df`, `function:write_stdin=9c3adbaa65e36ce23c7f1a8778e094a14b2086c993fc783727156276831c99dd`, and `namespace:skills=57809a76062bfe55966eca83c564e2bf71965bacd3c1c48349b0418f4e9f98b5`. Both `read-only` and `workspace-write` fixture variants contain exactly those six entries and no others; their catalog hash is `d93bcca0743ca4e8431ed81e418c72b5cd09c5f83f68dbe9410f0d9a6a969478`.

Fixture entry bytes are RFC 8785 canonical JSON of the five-field projection. Entry SHA-256 is over those bytes. Catalog SHA-256 is over UTF-8 `codex-orchestrator-tool-catalog-v1\0`, then for each entry sorted by UTF-8 bytes of `type + "\0" + name`, four-byte unsigned big-endian canonical-byte length plus canonical bytes. The initial structural bundle requires `mcpTools: []` on every node and `targetPolicy.mcpServers: {}`; any non-empty value blocks as `orchestrator-mcp-catalog-fixture-missing`. Adding an MCP tool requires a later reviewed bundle/config version with its own pinned full projection and real-server fixture; it is not inferred from a live target. Runtime loads the variant by manifest sandbox class and persists `expectedToolCatalogHash`; it does not claim to observe the model-bound catalog before a model request exists. The release contract suite reads this fixture before starting Codex, verifies its pinned entry/catalog hashes, then captures the first real request and requires byte-equal canonical projections and hash. Any other CLI version blocks before claim.

```ts
interface PersistedAuthLeaseV1 {
  version: 1;
  token: string;
  runId: string;
  hostId: string;
  bootNonce: string;
  ownerPid: number;
  phase: "reserved" | "armed" | "running" | "closing";
  supervisorPid: number | null;
  processGroupId: number | null;
  appServerPid: number | null;
  acquiredAt: string;
  updatedAt: string;
}
```

Persisted auth uses this exact acquire/launch protocol before issue selection: atomically acquire the lease as `reserved` with the Runner `ownerPid`; spawn the package Node supervisor as a detached group leader with a private control pipe, but do not let it spawn Codex; token-compare and fsync an `armed` lease containing its PID/PGID; send `{ op: "start", token }`; receive the Codex child PID over the control pipe; token-compare and fsync `running`; initialize and call `account/read`; only then may issue selection/claim continue. The supervisor exits without spawning Codex if the pipe closes or no matching start token arrives within 10,000 ms. After release it proxies stdio, keeps Codex in its process group, and terminates the group on parent-pipe loss.

Acquire/spawn/arm/start/PID-report/initialize/account failures have exact cleanup: a `reserved` lease with no supervisor is token-released; once a PGID is recorded, the owner first transitions to `closing`, terminates and proves the whole group absent, then token-releases. Reclaim on the same host/boot waits while `ownerPid` is alive. If the owner is dead, `reserved` with no supervisor is tombstoned and reclaimed; `armed`, `running`, or `closing` requires recorded-group termination and confirmed absence before tombstone/reacquire. Foreign host, ambiguous PID/PGID identity, missing armed PGID, or failed termination blocks as `orchestrator-auth-runtime-reconcile-required`. A contender never releases another token. `closeRun` performs the same `closing` -> group-absent -> token-release sequence; lease release is forbidden while a recorded supervisor/app-server group may still live.

`RunnerStateStore` is the only source of truth for package graph/node attempts. `MissionStateStore` remains the separate resolution-mission owner and receives no duplicate graph fields. Runner state stays at `join(targetRoot, config.runner.stateDir, "runner-state.json")`; v2 adds adjacent `runner-state.lock`, monotonic `generation`, compare-and-swap update, temp-file fsync, atomic rename, and directory fsync. The lock owner JSON is exactly `{ version: 1, token, hostId, bootNonce, pid, acquiredAt }`, reusing `mission-coordinator-lock.ts` validation. Acquisition polls every 25 ms for at most 5,000 ms. Foreign host fails. Same host with a different boot nonce is stale and reclaimed. Same host+boot with a live PID waits; a definitely dead PID is reclaimed by rename-to-owned-tombstone; ambiguous process status fails. Release removes the lock only after token equality. Writer crash/dead-owner, reboot nonce, live-owner timeout, foreign owner, PID reuse, and token-mismatched release have RED tests. A stale state generation retries the pure mutation against the newest snapshot while still locked; it never overwrites another run.

```ts
interface SkillRuntimeRecordV2 {
  packageVersion: string;
  bundleHash: string;
  bundleRoot: string;
  operationId: string;
  entrySkillPath: string;
}

interface WorktreeBaselineV2 {
  headSha: string;
  indexTreeSha: string;
  statusSha256: string;
  contentSha256: string;
  ownershipToken: string;
}

interface TransportExecutionRecordV2 {
  executionId: string;
  kind: "initial" | "clean-retry" | "partial-continuation";
  status: "prepared" | "running" | "terminal" | "reconciled" | "blocked";
  intentPersistedAt: string;
  process?: { pid: number; processGroupId: number; host: string; bootNonce: string; startedAt: string };
  appServer?: { threadId: string; turnId?: string };
  report: { path: string; sha256?: string; atomicWriteComplete: boolean };
  terminal?: {
    kind: CodexExecutionRunResultV2["status"];
    acknowledgedAt: string;
    sideEffectsQuiescedAt: string;
    quiescenceProof: "thread-clean-empty" | "process-group-absent";
  };
  recovery?: { kind: CodexExecutionRunResultV2["recovery"]; artifactPath?: string; reason?: string };
}

interface NodeAttemptRecordV2 {
  attemptId: string;
  nodeId: string;
  ordinal: number;
  status: "prepared" | "running" | "terminal" | "reconciled" | "blocked";
  cleanRetriesConsumed: 0 | 1;
  partialContinuationsConsumed: 0 | 1;
  baseline: WorktreeBaselineV2;
  executions: TransportExecutionRecordV2[];
}

interface GraphProgressRecordV2 {
  graphId: string;
  templateId?: string;
  reviewProfile?: ReviewProfile;
  currentNodeId: string;
  completedNodeIds: string[];
  joinIds: string[];
  artifactRefs: string[];
  reviewBudget: { maximum: number; consumed: number };
  reviewers: Array<{ reviewerId: string; threadId: string; mode: "full" | "closure" }>;
  findings: string[];
  aggregateVerdict?: "Approved" | "Needs Work" | "Rejected";
  closureCount: number;
  attempts: NodeAttemptRecordV2[];
}

interface RunnerProcessMetadataV2 extends RunnerProcessMetadata {
  stateVersion: 2;
  runId: string;
  skillRuntime: SkillRuntimeRecordV2;
  executionPolicyHash: string;
  effectivePolicySummary: TargetExecutionPolicyV2;
  graph: GraphProgressRecordV2;
}

interface RunnerStateFileV2 {
  version: 2;
  generation: number;
  runs: Array<RunnerProcessMetadata | RunnerProcessMetadataV2>;
}
```

Attempt write order is fixed: (1) create one logical `NodeAttemptRecordV2`; append an `initial` execution with `prepared` intent and baseline before spawn; (2) persist PID/PGID and execution `running` from the spawn callback; (3) persist thread ID, then turn ID, before awaiting terminal events; (4) atomically write/fsync report and persist its hash plus execution terminal acknowledgement; (5) in one CAS mutation mark execution and logical attempt `reconciled`, append artifact refs, advance/join the graph, and only then dispatch the successor. A valid hashed terminal report with missing transition is replayed without rerunning Codex.

Transport recovery is bounded to one clean retry and one partial continuation per logical node attempt; neither resets graph/review/rework budgets. Before each fresh process spawn, one CAS mutation increments the matching node-level consumed counter and appends a new `TransportExecutionRecordV2` with a unique `executionId` and `prepared` status; previous execution history is immutable. Clean retry requires the exact baseline. Partial continuation requires the same live runner ownership token, same canonical runner-owned issue worktree, unchanged HEAD and index tree, no committed/staged changes, every unstaged/untracked path inside target-allowed worktree scope, deny/safety checks passing, and no read-only node. It writes a diff/status artifact and supplies that path to a fresh exact-path thread. Any failed predicate, any read-only mutation, exhausted counter, or second mutation blocks as `partial-node-mutation`; no reset/checkout/erase occurs.

V1 and v2 parsers are explicit. Phase A adds forward-compatible `RunnerStateFileV2` envelope support while config remains v1: bridge code may store only legacy `RunnerProcessMetadata` entries in its `runs` union. Phase B setup, under the exclusive fence and after proving the union empty, writes an empty v2 envelope before the config commit rename. A pre-rename crash leaves config v1 operational because the bridge understands the empty v2 envelope and can append legacy entries; a later migration must drain them again. After config v2 commit, static preflight rejects every legacy union member and all new/nonterminal records are `RunnerProcessMetadataV2`. No v1 record is inferred into a bundle hash or graph.

Phase A publishes `bridge-runtime.json` in the npm package with strict `{ version: 1, packageVersion, packageHash, files: [{ path, mode, size, sha256 }] }`. `files` is the sorted `package.json`, `dist/src/**`, `prompts/**`, `README.md`, `docs/deep-dive.md`, and `CHANGELOG.md` publication closure excluding `bridge-runtime.json`; `packageHash` uses the bundle byte framing with magic `codex-orchestrator-bridge-package-v1\0`. Prepack verifies the checked-in/generated manifest against packed bytes.

The bridge writes `join(targetRoot, config.runner.stateDir, "skill-runtime-v2", "prepared-generation.json")` with this exact strict schema:

```ts
interface PreparedSkillRuntimeGenerationV1 {
  version: 1;
  canonicalTargetRoot: string;
  preparedAt: string;
  hostId: string;
  bootNonce: string;
  bridgePackageVersion: string;
  bridgePackageHash: string;
  activityFenceGeneration: number;
  inspectedProcesses: Array<{ pid: number; uid: number; startTime: string; executable: string; argv: string[] }>;
  runnerState: { path: string; sha256: string; nonterminalV1RunIds: [] };
  githubDrain: { queriedAt: string; runningIssueNumbers: [] };
}
```

Preparation writes the artifact by fsynced temp+rename while holding the exclusive fence. Phase B reads only this canonical path, re-hashes the current target/config state, requires empty arrays, and requires `bridgePackageHash` in `bundle.json.acceptedBridgePackageHashes`; user-supplied alternate paths or release metadata are not authority.

### 2.3 Config V2 And Migration Matrix

Only the `codex`, `project`, and `workflows` portions change shape; all other validated project policy remains field-for-field.

```ts
interface CodexProfileConfigV2 {
  model: string | null;
  effort: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  env: Record<string, string>;
}

interface TargetMcpServerPolicyV2 {
  url: string;
  httpHeaders: Record<string, string>;
  enabledTools: string[];
  approvals: Record<string, "never">;
}

interface TargetExecutionPolicyV2 {
  network: "deny" | "allow-listed";
  networkHosts: string[];
  writableRootClasses: WritableRootClass[];
  mcpServers: Record<string, TargetMcpServerPolicyV2>;
}

interface CodexOrchestratorConfigV2 extends Omit<CodexOrchestratorConfig, "version" | "codex" | "project" | "workflows"> {
  version: 2;
  codex: {
    adapter: "codex-app-server";
    command: "codex";
    serverArgs: [];
    requiredVersion: "0.144.4";
    timeoutMs: number;
    idleTimeoutMs: number;
    profiles: Partial<Record<CodexPhase, CodexProfileConfigV2>>;
    targetPolicy: TargetExecutionPolicyV2;
  };
  project: { configDir: ".codex-orchestrator" };
}
```

Migration mapping is exact:

| V1 field | V2 action | Blocker ID |
| --- | --- | --- |
| `codex.adapter` | Accept only `codex-cli`; emit `codex-app-server`. | `config-v2-adapter-unsupported` |
| `codex.command` and every profile `command` | Accept only literal `codex`; emit root `command: "codex"`; reject custom values. | `config-v2-command-unsupported` |
| `codex.args` and every profile `args` | Accept only package defaults after placeholder normalization; emit `serverArgs: []`; reject custom/raw args. | `config-v2-args-unsupported` |
| `timeoutMs`, `idleTimeoutMs` | Preserve positive integers. | `config-v2-timeout-invalid` |
| `mobileTimeoutMs` | Move to `profiles["visual-proof"].timeoutMs` only when that profile has no timeout; otherwise require equal values. | `config-v2-mobile-timeout-conflict` |
| profile `env` | Preserve only keys outside the exact forbidden set below. | `config-v2-profile-env-forbidden` |
| profile model/effort | Preserve model string/null and only `minimal`, `low`, `medium`, `high`, `xhigh`, or null; raw `-c`/argv-derived model settings are rejected. | `config-v2-profile-model-unsupported` |
| `ignoreUserConfig` | Accept `true`/missing and remove; reject `false`. | `config-v2-user-config-enabled` |
| `figmaMcp` | `enabled:false` maps to no server. `enabled:true` blocks because the initial release has no approved MCP catalog fixture; guidance requires a later reviewed bundle/config version, not a target-local v2 edit. | `config-v2-figma-tools-required` |
| `promptFileEnv`, `reportFileEnv` | Accept only existing literals and remove; paths are typed adapter fields. | `config-v2-report-env-unsupported` |
| `project.promptsDir` | Remove after accepting only `.codex-orchestrator/prompts`. | `config-v2-prompts-dir-unsupported` |
| `workflows` | Remove; report the approved old-to-new aliases but store none. Any custom source/path/skill blocks. | `config-v2-workflow-override` |

Every migrated v1 consumer starts with `targetPolicy.network: "deny"`, `networkHosts: []`, `writableRootClasses: ["proof-artifacts", "target-state", "worktree"]`, and `mcpServers: {}`. This intentionally narrows the current raw `network_access=true`/ambient MCP defaults; no node gains authority because the effective policy is still the restrictive intersection. Initial-release config validation requires `mcpServers: {}` exactly; any server/tool/approval entry, including `"on-request"`, blocks as `orchestrator-mcp-catalog-fixture-missing`. A later reviewed bundle/config version may introduce exact MCP fixtures. `allow-listed` requires at least one lowercase host without scheme/path/wildcard and intersects by exact host equality; `deny` always produces an empty effective host set. Writable classes map only to `worktreePath`, `join(targetRoot, config.runner.stateDir)`, and the configured Acceptance Proof artifact directory; no arbitrary path is accepted.

App-server parent env precedence is exact: start empty; copy `PATH`, `LANG`, `LC_ALL`, `TMPDIR`, `CODEX_CA_CERTIFICATE`, and `SSL_CERT_FILE`; apply allowed profile/phase env; optionally copy `CODEX_ACCESS_TOKEN` only for trusted automation; then set package `HOME`, `CODEX_HOME`, and per-run `CODEX_SQLITE_HOME` last. The forbidden profile/phase set is `HOME`, `CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS`, `CODEX_ORCHESTRATOR_ALLOW_MOBILE_DEVICE_CONTROL`, `CODEX_ORCHESTRATOR_MOBILE_DEVICE_GUARD`, `CODEX_ORCHESTRATOR_PROMPT_FILE`, and `CODEX_ORCHESTRATOR_REPORT_FILE`. Thread shell-environment policy removes all auth keys; if CLI 0.144.4 cannot prove `CODEX_ACCESS_TOKEN` is absent from model-launched tools, env auth blocks as `orchestrator-auth-env-unsupported` and only persisted package-home login is accepted.

Package-home creation uses `lstat` no-follow checks, rejects symlinks/non-owner paths, creates directories as `0700`, and never opens auth bytes in Runner code. `CODEX_SQLITE_HOME` is `join(packageHome, "sqlite", runId)` to isolate per-run session/cache databases. One supervised app-server process is owned per run and reused for every node; parallel A/B reviewer nodes are separate threads/turns in that same process. Persisted package-home login requires the exact `PersistedAuthLeaseV1` launch/reclaim/close state machine above at `join(packageHome, "app-server-persisted-auth.lock")`; another live owner returns `orchestrator-auth-runtime-busy` before issue claim and the daemon may retry on its next poll. `CODEX_ACCESS_TOKEN` mode does not write/refresh persisted auth, needs no global persisted-auth lease, and may run multiple supervised processes with distinct SQLite homes. Tests prove the reserved/armed/running/closing crash matrix, same-process parallel threads for persisted login, cross-process fail-before-claim, stale owner plus live-group reconciliation, parent-pipe loss cleanup, and multi-process token mode; no undocumented concurrent persisted-auth refresh is assumed.

### 2.4 Contract Test Ledger

| Invariant | Risk It Prevents | First RED Test / Proof | Status |
| --- | --- | --- | --- |
| Bridge preparation and v2 migration cannot overlap a daemon, targeted claim, targeted recovery, or another setup for the same canonical target; prior-boot owners are stale before PID liveness probing. | Legacy/v2 processes recover or claim work against a partially migrated config, or stale metadata survives a reboot behind a reused live PID. | `test/target-activity-fence.test.ts`: daemon-vs-prepare, claim/recovery-vs-prepare, prepare-vs-prepare, prior-boot different-PID owner, stale owner and foreign-host cases. | green — focused fence/recovery/config-race tests and full suite pass; `CLEANUP-001`, `CLEANUP-002` repaired after Full review and awaiting Closure verification |
| Preparation accepts only exact same-host bridge executable/version ownership and zero active/claimed v1 work across process, local-state, and GitHub evidence; Darwin fails closed before filtering when exact argv boundaries are unavailable. | A pre-fence, hidden old daemon, claim-before-state crash, or space-containing Darwin target survives cutover. | `test/skill-runtime-v2-preparation.test.ts`: version mismatch, PID reuse, Darwin/Linux identity, unsupported platform, ambiguous argv with spaces, multi-host metadata, open `agent:running` issue, GitHub unavailable, and crash after claim comment but before local state. | green — focused preparation tests and packed-byte verification pass; `CLEANUP-003` repaired after Full review and awaiting Closure verification |
| Bundle hash and manifest closure cover every selected skill/resource/tool and reject path escape or undeclared runtimes. | Missing/stale/host-dependent workflow code executes. | `test/package-skill-bundle.test.ts` and `test/runtime-skill-import.test.ts`. | planned |
| Bundle publication verifies, seals, and fsyncs the temp tree before no-overwrite rename; losers only verify the winner. | A partial/mutable destination is observed or concurrent materializers corrupt it. | `test/package-skill-bundle.test.ts`: crash before/after publish, concurrent winner/loser, sealed-mode drift, and owned temp cleanup. | planned |
| Package Node tools match approved golden outputs and exit codes without Python at runtime. | Adapted skill semantics drift or consumer requires ambient Python. | `test/runtime-skill-tools.test.ts` with Python unavailable for runtime cases. | planned |
| Operation mapping, approved-plan high reviewer C topology, graph edges, checkpoints, authority caps, and budgets come only from `bundle.json`. | Imported-current policy, target, or model bypasses mandatory review or widens authority. | `test/package-skill-graph.test.ts`: plan-vs-global high topology fixture, invalid edge, skipped reviewer, shared thread, budget restart, authority widening. | planned |
| A v2 run pins a content-addressed bundle before Codex starts and resumes the exact hash after package upgrade. | Resume silently executes newer instructions. | `test/package-skill-bundle.test.ts` plus `test/local-state.test.ts`. | planned |
| App-server sessions use package HOME/CODEX_HOME, disabled catalog/plugins/apps/native agents, and exact structured package skill paths only. | Personal/repo/plugin state or same-name skills leak into the model. | `test/codex-app-server-contract.test.ts` against CLI 0.144.4 and fake provider request capture. | planned |
| Cancellation reaches `turn/completed(interrupted)`, cleans and verifies an empty background-terminal list for only that node's thread before any retry/continuation. | A cancelled node's background shell keeps mutating the worktree or cleanup kills a healthy sibling. | `test/app-server-process.test.ts`: A background terminal + timeout while B completes, method/capability missing before turn, clean failure, non-empty post-clean list, and no retry before cleanup proof. | planned |
| Every completed, failed, or interrupted turn cleans and proves an empty per-thread background-terminal list before report acceptance, state transition, retry, continuation, or successor. | A successful node leaves a background process mutating the worktree during its successor. | `test/app-server-process.test.ts` and `test/package-skill-graph.test.ts`: successful A starts a background terminal, completes, and B cannot start until clean/list is empty; failed-turn and cleanup-failure variants. | planned |
| Every server-initiated request in the generated 0.144.4 union has a bounded fail-closed response and blocks the scoped node; runtime approval policy and per-tool approvals are exactly `never`. | Unattended execution hangs awaiting a user, auto-approves authority, or silently changes behavior. | `test/app-server-client.test.ts`: exhaustive generated-union matrix, exact decline/empty/error payloads, unknown method, interrupt/clean follow-up, and config rejection of `on-request`. | planned |
| Untrusted payloads live in context JSON and no Runner-authored turn contains a literal skill invocation token. | Issue/report text injects an ambient skill. | `test/package-skill-graph.test.ts` and call-site tests with adversarial payload text. | planned |
| Runtime accepts exactly CLI `0.144.4`, loads the independently pinned six-entry catalog fixture before thread creation, and release tests prove the first real Responses request byte-matches its canonical projection/hash. | A circular expected value, target MCP, or untested newer CLI exposes extra tools while appearing green. | `test/package-skill-bundle.test.ts`: exact fixture entry/catalog hashes and empty MCP policy; `test/codex-command-adapter.test.ts`: non-empty MCP/version mismatch before claim; `test/codex-app-server-contract.test.ts`: fixture loaded before process start and captured projection byte equality. | planned |
| Read-only node mutation is a policy violation; partial implementation mutation is continued only with audited context or blocks without reset. | Blind retry duplicates/overwrites work or hides unauthorized writes. | `test/codex-command-adapter.test.ts`: clean orphan retry, mutated orphan continuation, ambiguous mutation block, read-only mutation. | planned |
| `RunnerStateStore` token/PID/boot-nonce lock plus CAS preserves parallel updates and recovers dead writers without releasing another owner. | Daemon/child concurrency loses graph state, dead lock stalls all work, or crash/restart skips gates. | `test/local-state.test.ts`: parallel upsert/remove/transition, writer crash while locked, live timeout, foreign owner, PID reuse, mismatched release token, stale generation, fsync/rename crash; `test/package-skill-graph.test.ts`: artifact-before-successor. | planned |
| Node attempts persist PID/PGID/thread/turn/baseline/report/terminal state and use one clean retry plus one guarded partial continuation without resetting other budgets. | Orphans duplicate work, replay terminal nodes, or erase partial/user changes. | `test/codex-command-adapter.test.ts` and `test/local-state.test.ts`: full crash matrix and exact safe-continuation predicates. | planned |
| Migration commit is one atomic config rename after backup, candidate doctor, fsync, and bridge/drain proof; post-rename recovery republishes generation before claims. | Crash leaves mixed authoritative config/generation. | `test/setup-command.test.ts`: crash before/after rename, invalid candidate, active v1, generation reconciliation. | planned |
| Static bundle/CLI/auth/config/state preflight runs before issue selection, labels, branch, or worktree mutation. | A loader/auth failure claims or mutates GitHub/local work. | `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, and `test/daemon-command.test.ts` mutation-spy cases. | planned |
| All six Codex call sites execute manifest graph nodes and no runtime path reads target workflow prompts. | Some flows retain stale prompt ownership. | Focused tests for each call site plus `rg` exit proof in Slice 6. | planned |
| Packed tarball contains every manifest file and a temp consumer with conflicting skills still selects only package entries. | npm publication omits runtime assets or installed-path resolution uses cwd. | `test/package-tarball.test.ts` plus temp-install contract suite. | planned |
| Persisted login acquires `reserved` before spawn, fsyncs the gated supervisor PID/PGID before Codex starts, reconciles dead-owner groups, and releases only after group absence; multi-process mode requires `CODEX_ACCESS_TOKEN` and distinct SQLite homes. | A spawn/PID crash window leaves an unleased auth process, concurrent managed-auth refresh corrupts credentials, or serialization removes required A/B parallelism. | `test/package-runtime-home.test.ts`: every reserved/armed/running/closing crash edge, parent death before/after start token, initialize/account failure, dead owner with live group, ambiguous termination, token mismatch, persisted same-process A/B, second-process fail-before-claim, and two token-auth processes. | planned |

## Risk Controls

- **Source of Truth:** `runtime-skills/bundle.json` owns operations, approved-plan graph topology, selected skills, resources, hashes, and maximum node authority. `package-skill-bundle.ts` owns provenance/materialization; `package-skill-graph.ts` owns transitions/policy intersection; `RunnerStateStore` alone owns graph/node-attempt state; target config is only a narrowing project-policy input.
- **Safety Constraints:** Package runtime uses a dedicated no-follow `0700` home and supported account APIs or `CODEX_ACCESS_TOKEN` only under the exact non-leak contract above. Personal config/auth/instructions/skills/plugins/apps are never read, copied, or modified outside the explicit allowlisted source import. Every model node has `externalWrite=false`; runner-owned publication remains behind existing durable intent/idempotency/reconciliation contracts.
- **Contract Constraints:** CLI is pinned exactly to `0.144.4`; any other version blocks before claim. Runtime pre-turn probes prove initialize, exact skill-path acceptance, config restrictions, and per-thread background-terminal methods without claiming model-bound catalog visibility. Runtime loads the independently pinned six-entry expected fixture; initial-release MCP is empty. The real-CLI fake-provider release suite proves the actual first-request projection against that fixture/hash. Unknown fields, methods, requests, capabilities, or catalog entries fail closed.
- **Concurrency / State Constraints:** Activity fence covers bridge daemon lifetime, targeted claims, preparation, and migration. Bundle temp trees are complete, verified, sealed, and fsynced before no-overwrite publish; destinations are never mutated and no GC exists. Runner state uses lock plus generation CAS. Exact node-attempt ordering/retry predicates apply; orphan recovery never resets or erases user/unrelated changes.
- **Forbidden Scope:** No exec fallback, plugin distribution, personal skill synchronization, automatic GC, multi-host migration, model-selected next skill/path, target authority widening, generic compatibility branch, live smoke, release, publication, or push.
- **Early Review Gate:** Phase A has its own bridge-only `$code-review`, cleanup review, test gate, and verified `bridge-runtime.json` before the unconditional authorization hold. Phase B has a second `$code-review` after Slice 2 on manifest/provenance, graph reducer, state v2, concurrency, and restart tests. Do not begin app-server or call-site cutover until that gate is green.
- **Final Handoff Requirements:** Final response must state the contract implemented; bridge/structural checkpoint status; main isolation, provenance, graph, state, recovery and migration invariants proved; early/final review findings and fixes; exact validation; skipped live/release checks; residual risks; and files grouped by bundle, runtime, transport, state/migration, call-site, test, and docs roles.

## Write Scope Summary

- `package.json` - Add `runtime-skills` to published files and importer/validation scripts; keep `prepack` deterministic and offline.
- `bridge-runtime.json` - Add in Phase A; strict installed bridge publication manifest/hash used by canonical prepared-generation evidence.
- `runtime-skills/**`, `scripts/import-runtime-skills.mjs` - Add checked-in adapted bundle, manifest, adaptation map/report, golden fixtures, operation skills, skill closure, shared resources, and Node tools.
- `src/runner/target-activity-fence.ts`, `src/setup/skill-runtime-v2-preparation.ts` - Add bridge fence and strict canonical `prepared-generation.json` ownership.
- `src/skills/package-skill-bundle.ts`, `src/skills/package-skill-graph.ts` - Add provenance/materialization and pure graph/policy owners.
- `src/codex/execution-adapter.ts`, `src/codex/app-server-client.ts`, `src/codex/app-server-process.ts`, `src/codex/app-server-supervisor.ts`, `src/codex/package-runtime-home.ts`, `src/codex/command-adapter.ts` - Replace exec transport with isolated app-server, gated process ownership, exhaustive server-request handling, and scoped terminal cleanup while preserving the runner seam.
- `src/runner/skill-runtime-preflight.ts`, `src/setup/skill-runtime-v2-migration.ts` - Add pre-claim gates and atomic v2 migration.
- `src/config/constants.ts`, `src/config/schema.ts`, `src/setup/project-config.ts`, `src/setup/setup-command.ts`, `src/cli.ts`, `src/index.ts` - Add exact v2 config/auth/preparation interfaces and remove workflow/exec config ownership.
- `src/runner/local-state.ts` - Add explicit v1/v2 parsers, cross-process lock/generation CAS, and required skillRuntime/policy/graph/node-attempt state. `src/runner/mission-state-store.ts` is regression-tested but does not duplicate graph state.
- `src/runner/daemon-command.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/runner/agent-attempt.ts`, `src/runner/acceptance-proof-runner.ts`, `src/runner/local-execution-session.ts`, `src/runner/fresh-context-review.ts`, `src/runner/prompt.ts`, `src/runner/doctor-command.ts` - Fence/preflight and cut over all six Codex flows to package graphs/context artifacts.
- `src/setup/prompt-sync.ts`, `src/setup/workflows.ts`, `prompts/**` - Delete only after v2 migration coverage and call-site tests prove no runtime consumer remains; legacy target prompt files stay untouched and inert.
- `test/**` - Add the exact new tests named in slices and update existing config/setup/doctor/daemon/runner tests and fixtures.
- `README.md`, `docs/deep-dive.md`, `docs/agents/execution-routing.md`, `CHANGELOG.md` - Document the bridge, package runtime, auth, migration, validation, and separately authorized release sequence.

## Halt Conditions

- [ ] Stop before structural implementation if bridge fencing cannot cover daemon lifetime, targeted claim, preparation, and setup under one canonical target identity without weakening current mission locking.
- [ ] Stop before any config write if bridge preparation, active/resumable v1 drain, package provenance, app-server capability, or package-home auth evidence is missing or ambiguous.
- [ ] Stop before a model turn if any package entry/hash/path, exact CLI version, required app-server method/config restriction, exact structured skill selection, execution-policy intersection, or checked-in expected catalog fixture/hash cannot be proven. Actual model-bound catalog equality is a release-test proof against the pinned binary, not a runtime pre-turn claim.
- [ ] Stop recovery if surviving worktree mutation cannot be attributed to the recorded implementation attempt with intact HEAD/index ownership; preserve evidence and return `partial-node-mutation`.
- [x] Stop unconditionally after Phase A bridge-only cleanup review, code review, tests, and verified `bridge-runtime.json`. Phase B cannot begin in the same execution; it requires an actually released bridge, canonical prepared-generation evidence, and a fresh resumed run. The authorized `0.1.50` release candidate has bridge hash `033717e392b8b021eb72c7f1f90e5701e922565648429892ae6f9fdf941ca5c3`.
- [x] Stop before live smoke, npm publication, push, release, or consumer migration unless the user separately authorizes that exact action. The user authorized bridge commit/push/release and canonical consumer preparation on 2026-07-15; live smoke remains unauthorized and skipped.

## 3. Execution Slices

### Progress Discipline

- [x] Update this checklist and Contract Test Ledger as work moves planned -> red -> green or blocked.
- [x] Leave blocked work unchecked with a short `Blocked:` note and preserved evidence.
- [ ] Stop when repo reality contradicts a confirmed target, command, contract, release boundary, or source decision.
- [x] Start each behavior-changing slice with the stated RED proof; implement only enough to make that vertical contract green, then refactor.
- [x] Preserve unrelated work and the source plan; never stage broad directories by default.
- [x] Run bridge-only cleanup/code-review before the Phase A terminal hold; after Phase B resumes, run the structural Early Review Gate after Slice 2 and final cleanup/code-review gates after settled validation. Phase A cleanup Full, integrator Full, and same-session Closure are complete; Phase B review gates remain blocked by the resume gate.

### Slice 0 - Bridge Activity Fence And Preparation

- [x] Objective: A bridge package can prove no legacy daemon/claim/setup races with v2 preparation while leaving current prompt execution unchanged.
- [x] Test/Proof First: Add failing `test/target-activity-fence.test.ts` and `test/skill-runtime-v2-preparation.test.ts` cases for daemon lifetime, targeted claim, concurrent preparations, stale same-host owner, foreign host, Darwin/Linux identity, PID reuse, executable/version mismatch, ambiguous argv, unsupported platform/tooling, nonterminal v1 local state, open GitHub running-label claim, GitHub read failure, claim-before-local-state crash, and crash before prepared-generation write.
- [x] Target: `src/runner/target-activity-fence.ts`
  - [x] Action: Implement canonical-target shared daemon/claim ownership and exclusive preparation/migration ownership using `mission-coordinator-lock.ts` PID/boot-nonce/token semantics; persist generation under the configured target state directory.
  - [x] Validation: Fence tests prove mutual exclusion, same-host stale recovery, foreign-host blocking, and release that cannot delete another token's ownership.
- [x] Target: `src/setup/skill-runtime-v2-preparation.ts`
  - [x] Action: Implement the Darwin/Linux identity sources defined in Preconditions for exact canonical target plus `codex-orchestrator daemon` executable/argv identity; verify running package is the bridge generation; while fenced, require empty process, v1 local-state, and GitHub running-label claim sources; persist inspected PID/start-time/executable identities, host boot nonce, bridge package hash, GitHub query timestamp, and zero-active-v1-run evidence.
  - [x] Validation: Preparation tests reject every ambiguous/pre-fence/multi-host case without writing a generation.
- [x] Target: `src/runner/local-state.ts`, `bridge-runtime.json`, `package.json`
  - [x] Action: Add the forward-compatible `RunnerStateFileV2` envelope that bridge config v1 can read/write with legacy union entries; generate and verify the strict bridge package manifest/hash over the publication closure.
  - [x] Validation: Bridge tests prove config v1 remains operational with an empty v2 envelope and after appending a legacy run; pack tests prove `bridge-runtime.json` matches installed bytes.
- [x] Target: `src/runner/daemon-command.ts`, `src/runner/scoped-auto-command.ts`, `src/runner/plan-auto-command.ts`, `src/setup/setup-command.ts`, `src/cli.ts`
  - [x] Action: Hold/validate the activity fence at daemon lifetime, targeted command/claim, setup, and `setup --prepare-skill-runtime-v2`; do not change skill/prompt execution in this slice.
  - [x] Validation: Existing daemon/scoped/plan/setup tests plus new race tests pass.

#### Slice 0 Exit Gate

- [x] `npm run build --silent && node --test dist/test/target-activity-fence.test.js dist/test/skill-runtime-v2-preparation.test.js dist/test/mission-coordinator-lock.test.js dist/test/daemon-command.test.js dist/test/scoped-auto-command.test.js dist/test/plan-auto-command.test.js dist/test/setup-command.test.js dist/test/cli.test.js` — 128/128 passed after integrator repairs.
- [x] `npm run typecheck`
- [x] `npm test` — 711/711 passed after integrator repair batch.
- [x] `npm pack --dry-run --json`
- [x] Run `$cleanup-review`, apply safe fixes, rerun affected tests, then run bridge-only `$code-review`. Cleanup Full found five defects; integrator Full reopened three; the repair batch and same-session Closure verified all five.
- [x] Verify `bridge-runtime.json` against the actual `npm pack --json` closure and include it in the tarball; do not create an alternate release-candidate authority artifact. The authorized package `0.1.50` candidate has bridge hash `033717e392b8b021eb72c7f1f90e5701e922565648429892ae6f9fdf941ca5c3`, 456 manifest files, and 458 packed files.
- [x] Stop unconditionally with `Bridge release hold: bridge-only candidate is reviewed; commit/push/release and consumer preparation require separate authorization`. Do not execute Slice 1 in this run.

### Phase B Resume Gate

In progress: the user explicitly authorized the bridge commit/push/release and canonical consumer preparation on 2026-07-15. Slice 1 remains unavailable until the release workflow succeeds and the released package writes canonical `prepared-generation.json`.

- [ ] Start a fresh execution from the exact released bridge commit, not from an uncommitted continuation of Phase A.
- [ ] Read only `join(targetRoot, config.runner.stateDir, "skill-runtime-v2", "prepared-generation.json")`; verify strict schema, target identity, empty drain arrays, current state hash, and released bridge package hash; add that exact hash to `bundle.json.acceptedBridgePackageHashes`.
- [ ] Stop before Slice 1 on any missing/mismatched evidence; never reconstruct, amend, or accept an alternate bridge-generation path inside the structural diff.

### Slice 1 - Self-Contained Bundle, Importer, And Immutable Provenance

- [ ] Objective: The packed package contains one complete, deterministic, runtime-independent skill closure that materializes by content hash.
- [ ] Test/Proof First: Add failing `test/runtime-skill-import.test.ts`, `test/runtime-skill-tools.test.ts`, `test/package-skill-bundle.test.ts`, and `test/package-tarball.test.ts` cases for missing references, path escape, personal absolute paths, automatic invocation/native delegation markers, undeclared Python/shell, undeclared graph requirement, hash/mode drift, concurrent materialization, corrupt reuse, cwd-independent installed resolution, no-Python runtime, and tarball omission.
- [ ] Target: `runtime-skills/**`, `scripts/import-runtime-skills.mjs`
  - [ ] Action: Run `node scripts/import-runtime-skills.mjs --source-root /Users/serhiimytakii/.codex`; import only the declared 16-skill transitive closure, shared policy, and exact Git helper blobs; emit `source-snapshot.json`, `adaptation-map.json`, `adaptation-report.json`, and canonical `bundle.json`; record the approved-plan high-review topology adaptation; port `review_context.py`, `detect_test_command.py`, and `artifact_review_fingerprint.py` to the three declared Node CLIs with checked-in golden fixtures.
  - [ ] Validation: Import is reproducible byte-for-byte; undeclared transformations/dependencies fail; Node output and exit-code fixtures match approved snapshots.
- [ ] Target: `src/skills/package-skill-bundle.ts`
  - [ ] Action: Validate the exact manifest schema/closure/hash; resolve `runtime-skills` from installed package location; publish the verified/sealed/fsynced temp tree without overwrite to `join(targetRoot, config.runner.stateDir, "runtime-bundles", packageVersion + "-" + bundleHash)`; losers only verify the winner; do not add GC.
  - [ ] Validation: Focused bundle tests prove concurrent writers converge, corruption blocks, old hash remains resumable, and package upgrade produces a new path only for new sessions.
- [ ] Target: `package.json`
  - [ ] Action: Publish `runtime-skills`; add deterministic importer/validator scripts; keep importer out of install/build/setup/runtime and make `prepack` validate the checked-in bundle before packing.
  - [ ] Validation: `npm pack --dry-run --json` and `test/package-tarball.test.ts` prove every manifest entry is present.

#### Slice 1 Exit Gate

- [ ] `npm run build --silent && node --test dist/test/runtime-skill-import.test.js dist/test/runtime-skill-tools.test.js dist/test/package-skill-bundle.test.js dist/test/package-tarball.test.js`
- [ ] `npm pack --dry-run --json`
- [ ] `npm run typecheck`

### Slice 2 - Runner Graph, Policy Intersection, And Durable State V2

- [ ] Objective: One pure manifest graph determines every allowed node, mandatory review/join/checkpoint, authority cap, persisted transition, and restart budget.
- [ ] Test/Proof First: Add failing `test/package-skill-graph.test.ts` cases for the approved operation sequences, simple/medium/high review topology, reviewer independence/thread uniqueness, fan-out/join, reserved budgets, closure re-entry, checkpoint blocking, model-requested invalid edge, unknown policy field, target/global narrowing, target widening, read-only/worktree-write classes, rejection of non-empty initial-release MCP policy, restart without budget reset, artifact-before-successor ordering, and aggregate failure.
- [ ] Target: `src/skills/package-skill-graph.ts`, `runtime-skills/bundle.json`
  - [ ] Action: Implement pure manifest parsing, operation start lookup, graph/template expansion, control-envelope validation, restrictive execution-policy intersection, joins/checkpoints/review budget, and deterministic transition reducer.
  - [ ] Validation: Reducer tests use serialized state round trips and prove no direct producer-to-gated-successor edge exists.
- [ ] Target: `src/runner/local-state.ts`
  - [ ] Action: Make `RunnerStateStore` the only graph/node-attempt owner; add explicit v1/v2 exact parsers, `runner-state.lock`, monotonic generation CAS, fsync/rename persistence, and the exact attempt write order above. Require `skillRuntime`, node-policy hash/effective summary, and `GraphProgressRecordV2` on every new/nonterminal v2 record. Keep v1 readable only for drain/block evidence.
  - [ ] Validation: State tests cover parallel upsert/remove/transition, dead-writer lock reclaim, live/foreign/PID-reuse/token-release lock cases, stale generation retry, mixed files, malformed/partial v2, active v1 detection, immutable transport-execution history, every attempt/retry/continuation crash point, terminal-report replay, consumed budgets, partial continuation predicates, exact-hash resume, and no inferred migration. Existing `test/mission-state-store.test.ts` remains green as a no-duplication regression.
- [ ] Target: `src/codex/execution-adapter.ts`
  - [ ] Action: Add the stable interface only; migrate test doubles and call-site types without changing runtime transport yet.
  - [ ] Validation: `npm run typecheck` and existing runner tests compile through the interface.

#### Slice 2 Exit Gate

- [ ] `npm run build --silent && node --test dist/test/package-skill-graph.test.js dist/test/local-state.test.js dist/test/mission-state-store.test.js`
- [ ] `npm run typecheck`
- [ ] Run `$code-review` on Slices 0-2 before continuing.

### Review Checkpoint - Provenance, Concurrency, And State

- [ ] Continue only after high-confidence findings are fixed and the focused tests rerun.

### Review Focus

- Activity-fence identity, stale-owner rules, setup-versus-daemon/claim races, and bridge-generation publication.
- Canonical hash/path closure, symlink/path traversal, concurrent materialization, immutable reuse, and no ambient runtime dependencies.
- Graph source-of-truth, mandatory reviewer fan-out/join/checkpoint/closure semantics, no model-selected paths, and no restart budget reset.
- Restrictive authority intersection, exact tool cardinality, read-only mutation, external-write denial, transition/artifact persistence ordering, and partial failure.

### Slice 3 - Isolated App-Server Transport And Auth

- [ ] Objective: The compatibility adapter runs one isolated exact-path graph node through the exactly pinned app-server, proves the expected policy before turn, and proves the actual model request/catalog in the release contract suite.
- [ ] Test/Proof First: Add failing `test/app-server-client.test.ts`, `test/app-server-process.test.ts`, `test/package-runtime-home.test.ts`, `test/fixtures/fake-responses-provider.ts`, and `test/codex-app-server-contract.test.ts`; update `test/codex-command-adapter.test.ts`. Cover exact-version mismatch before claim, independently pinned catalog-fixture hashes loaded before process start, initialize/method mismatch, exhaustive generated `ServerRequest` handling, event correlation, protocol death, all-terminal background clean/list before report/transition, successful A with a background terminal before B, A timeout while B completes, shared-process death fan-out, idempotent close, supervisor launch-gate crash matrix, forced group cleanup/lease release, no-follow `0700` home, account missing/login, persisted-auth reserved/armed/running/closing lease/reclaim, same-process parallel A/B threads, token-mode multi-process distinct SQLite homes, `CODEX_ACCESS_TOKEN` non-leak, rejected `CODEX_API_KEY`/`OPENAI_API_KEY`, personal-tree byte snapshot, `skills/extraRoots/set`, force reload, exact structured skill order, `include_instructions=false`, absent plugin/app/native-agent tools, empty initial-release MCP, package loader error, ignored external loader error, every attempt crash/recovery state, and atomic final report.
- [ ] Target: `src/codex/app-server-client.ts`, `src/codex/app-server-process.ts`, `src/codex/app-server-supervisor.ts`
  - [ ] Action: Implement typed stdio JSON-RPC lifecycle; exact fail-closed server-request matrix; supervisor control-pipe launch gate; common `finalizeTurn` cleanup barrier for `completed`/`failed`/`interrupted`; sibling-safe cancellation; durable per-run process-group ownership; idempotent close; shared-death fan-out; and reconciliation. Preserve current log/result semantics and forbid report acceptance, transition, retry, continuation, or successor before cleanup proof.
  - [ ] Validation: Fake server tests prove request IDs, every generated request method, streamed events, terminal mapping, method capability failure before turn, successful-A-clean-before-B, A-timeout/clean while B completes, failed-turn cleanup, no surviving A terminal, unacknowledged/unclean turn behavior, idle timeout, protocol death fan-out, every supervisor/lease crash edge, repeated close, whole-group shutdown only when safe, and lease release only after process absence.
- [ ] Target: `src/codex/package-runtime-home.ts`, `src/cli.ts`
  - [ ] Action: Create the no-follow owner-only package home under `${CODEX_ORCHESTRATOR_HOME:-$HOME/.codex-orchestrator}/codex-home/v1`; use `account/read` for status/preflight and `account/login/start` for `codex-orchestrator auth login`; accept non-persistent `CODEX_ACCESS_TOKEN` only under the exact shell-env exclusion contract; use `join(packageHome, "sqlite", runId)` per run; redact credentials and never parse/copy personal auth.
  - [ ] Validation: Auth tests prove actionable `orchestrator-auth-required`, package-home-only writes, exact env precedence/non-leak, acquire-before-spawn launch gate, parent-pipe loss cleanup, persisted-login single-process lease with parallel threads, token-mode multi-process/distinct-SQLite behavior, and unchanged personal trees.
- [ ] Target: `src/codex/command-adapter.ts`
  - [ ] Action: Replace raw argv/stdin exec with strict exact-version app-server startup, exact skill roots/list validation, policy intersection, checked-in expected-catalog fixture loading/hashing, context-file input, invocation-token assertion, ordered structured skills, final-message persistence after `finalizeTurn`, and baseline/orphan reconciliation. Set `approvalPolicy: "never"`, omit dynamic tools, require empty MCP, reject target `on-request`, and remove raw v1 args/exec fallback. Do not claim runtime observation of the model-bound catalog before `turn/start`.
  - [ ] Validation: `test/fixtures/fake-responses-provider.ts` binds an ephemeral loopback port, returns its `baseUrl`, exposes `/v1/responses`, requires a test-only `FAKE_RESPONSES_KEY`, records request JSON and streamed response events, and fails on any other route. Process-local strict overrides are exactly `model="fake-model"`, `model_provider="orchestrator_fake"`, `model_providers.orchestrator_fake.name="Orchestrator Fake Responses"`, `model_providers.orchestrator_fake.base_url=baseUrl + "/v1"`, `model_providers.orchestrator_fake.env_key="FAKE_RESPONSES_KEY"`, and `model_providers.orchestrator_fake.wire_api="responses"`; the reserved built-in provider IDs are never reused. Before spawning Codex, the test reads `runtime-skills/tool-catalogs/codex-0.144.4.json` and verifies all six pinned entry hashes plus catalog hash. It then starts exactly CLI 0.144.4 app-server and asserts captured instructions, ordered structured skills, byte-equal actual tool projection/catalog hash, cwd, model `fake-model`, effort, `approvalPolicy: "never"`, and absence of untrusted text/auth env. No adapter-owned fake or captured-request-derived expected value may satisfy this test.

#### Slice 3 Exit Gate

- [ ] `npm run build --silent && node --test --test-concurrency=1 dist/test/app-server-client.test.js dist/test/app-server-process.test.js dist/test/package-runtime-home.test.js dist/test/codex-command-adapter.test.js dist/test/codex-app-server-contract.test.js`
- [ ] `npm run typecheck`

### Slice 4 - Runner-Owned Graph Cutover At All Six Call Sites

- [ ] Objective: Planning, implementation, proof, repair, and fresh review all run package graph nodes with file-based untrusted context and no target workflow prompt reads.
- [ ] Test/Proof First: Update `test/plan-auto-command.test.ts`, `test/scoped-auto-command.test.ts`, `test/local-execution-session.test.ts`, `test/acceptance-proof-loop.test.ts`, `test/acceptance-proof.test.ts`, and add focused fresh-review assertions. For each of the six sites prove operation ID, node order, exact package skill items, context artifact contents/path, adversarial literal invocation text isolation, persisted transition, bounded review/checkpoint behavior, and unchanged runner-owned publication/report semantics.
- [ ] Target: `src/runner/plan-auto-command.ts`
  - [ ] Action: Replace four target prompt reads and parent prompt execution with `plan-parent`: `to-spec -> to-tickets -> tickets-breakdown-review-template -> triage`; persist every graph artifact/transition.
  - [ ] Validation: Parent planning tests prove no direct successor before mandatory review and no prompt file dependency.
- [ ] Target: `src/runner/scoped-auto-command.ts`, `src/runner/agent-attempt.ts`
  - [ ] Action: Start `implementation-attempt`; run read-only classification, select only declared small/spec-required edge, add exact package `tdd` only for behavior-changing implementation nodes, enforce checkpoints, cleanup, code review, and final aggregation.
  - [ ] Validation: Scoped tests cover both branches, restart, bounded closure, write caps, and unchanged claim/publication behavior.
- [ ] Target: `src/runner/acceptance-proof-runner.ts`, `src/runner/local-execution-session.ts`, `src/runner/fresh-context-review.ts`
  - [ ] Action: Route `acceptance-proof`, `completion-report-repair`, `proof-evidence-repair`, and `fresh-context-review` operations through their manifest entry nodes; preserve existing report schemas, acceptance semantics, and fresh-review gate ownership.
  - [ ] Validation: Focused tests prove each operation uses its exact entry and no implementation authority leaks into proof/repair/review nodes.
- [ ] Target: `src/runner/prompt.ts`
  - [ ] Action: Replace workflow-text assembly with static turn text plus Runner-owned context JSON paths; keep durable context/report/log artifact helpers needed by state/handoff.
  - [ ] Validation: Prompt tests prove no literal skill invocation token and no untrusted body appears in turn text.

#### Slice 4 Exit Gate

- [ ] `npm run build --silent && node --test dist/test/plan-auto-command.test.js dist/test/scoped-auto-command.test.js dist/test/local-execution-session.test.js dist/test/acceptance-proof-loop.test.js dist/test/acceptance-proof.test.js`
- [ ] `npm test`
- [ ] `npm run typecheck`

### Slice 5 - Config V2, Atomic Migration, Doctor, And Pre-Claim Ordering

- [ ] Objective: Prepared consumers migrate once to exact transport config v2, and every command fails before claim/mutation when provenance, auth, loader, state, or policy proof is unavailable.
- [ ] Test/Proof First: Update `test/config-schema.test.ts`, `test/setup-command.test.ts`, `test/doctor-command.test.ts`, `test/daemon-command.test.ts`, `test/scoped-auto-command.test.ts`, `test/plan-auto-command.test.ts`, `test/cli.test.ts`, and `test/fixtures/config.ts`; add `test/skill-runtime-preflight.test.ts`. Cover every §2.3 mapping row and blocker ID, alias reporting, workflows removal, backup/fsync/candidate behavior, crash before/after rename, generation reconciliation, process/local/GitHub v1 drain including claim-before-state crash, missing/corrupt bundle, unsupported CLI/method/config, auth required, package/external loader distinction, and zero issue/label/branch/worktree mutation on all preflight failures.
- [ ] Target: `src/config/constants.ts`, `src/config/schema.ts`, `src/setup/project-config.ts`
  - [ ] Action: Implement `CodexOrchestratorConfigV2`, `TargetExecutionPolicyV2`, exact env precedence/forbidden keys, and the complete §2.3 migration matrix; remove runtime workflow mapping and raw exec/profile args. Preserve only recognized target policy that narrows signed node authority.
  - [ ] Validation: Exact parser tests reject unknown/widening/legacy fields with field-specific errors.
- [ ] Target: `src/setup/skill-runtime-v2-migration.ts`, `src/setup/setup-command.ts`
  - [ ] Action: Under exclusive fence, verify canonical prepared generation, accepted bridge hash, empty process/local/GitHub v1 drain, and static preflight; fsync backup of exact config/prompt manifest/state; write and doctor a config candidate via non-authoritative candidate API; write the empty `RunnerStateFileV2` envelope before config rename; leave legacy prompts untouched; atomically rename config as the only product commit point; fsync/reconcile activity generation before admitting work.
  - [ ] Validation: Crash before state-v2 write leaves v1 config/state; crash after state-v2 write but before config rename leaves v1 config operational through bridge forward compatibility and any newly appended legacy run blocks the next migration; crash after config rename has config/state v2 and reconciles generation before claim.
- [ ] Target: `src/runner/skill-runtime-preflight.ts`, `src/runner/doctor-command.ts`, command entry paths
  - [ ] Action: Run target-independent bundle/CLI/app-server/auth/config/state proof before issue selection/claim/worktree; after worktree creation validate only target policy/trust/pinned bundle/selected-node policy. Replace prompt-sync doctor checks.
  - [ ] Validation: Mutation spies remain empty for every static failure; doctor returns stable actionable blocker IDs.

#### Slice 5 Exit Gate

- [ ] `npm run build --silent && node --test dist/test/config-schema.test.js dist/test/setup-command.test.js dist/test/doctor-command.test.js dist/test/daemon-command.test.js dist/test/scoped-auto-command.test.js dist/test/plan-auto-command.test.js dist/test/skill-runtime-preflight.test.js dist/test/cli.test.js`
- [ ] `npm test`
- [ ] `npm run typecheck`

### Slice 6 - Legacy Removal, Package Consumer Proof, Docs, And Final Reviews

- [ ] Objective: No runtime source reads target workflow prompts or exec config, the packed package works in a conflicting-skill consumer, and the settled diff passes all local/review gates.
- [ ] Test/Proof First: Add/update tests so removal of prompt sync/workflow mapping/exec branches is required for green; add temp-install proof with conflicting repo/user skills, no Python, doctor, fake provider, and exact package-path selection.
- [ ] Target: `src/setup/prompt-sync.ts`, `src/setup/workflows.ts`, `prompts/**`, legacy branches/fixtures
  - [ ] Action: Delete package prompt sync/merge and runtime workflow sources only after Slice 5 migration tests are green; keep legacy target files untouched and report-only as removable artifacts.
  - [ ] Validation: `rg -n "workflowPromptText|readWorkflowPrompt|config\\.workflows|prompt-sync|codex exec|--ignore-user-config|--output-last-message" src test` returns only intentional migration/error-history references documented in the final reconciliation note.
- [ ] Target: `README.md`, `docs/deep-dive.md`, `docs/agents/execution-routing.md`, `CHANGELOG.md`
  - [ ] Action: Document package skill ownership, dedicated auth, bridge preparation, config/state v2, failure/recovery semantics, inactive legacy prompts, exact local validation, and separately authorized two-release rollout/rollback.
  - [ ] Validation: Docs match implemented command names/schema/blocker IDs and never imply that release/live smoke already ran.
- [ ] Target: Settled implementation diff
  - [ ] Action: Run local package install into a temporary repo with conflicting skills and fake provider; run all local gates; run `$cleanup-review`; apply safe fixes and rerun affected tests; run one final `$code-review` on the settled diff.
  - [ ] Validation: Reviews have no unresolved high-confidence blocker; all skipped external checks are explicit.

#### Slice 6 Exit Gate

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm pack --dry-run --json`
- [ ] Temp tarball consumer doctor/fake-provider contract suite passes with conflicting skills and no Python.
- [ ] `git diff --check`
- [ ] `$cleanup-review`
- [ ] `$code-review`
- [ ] `npm run smoke:live` recorded as skipped unless separately authorized.
- [ ] npm publication, bridge/structural release, push, and consumer migration recorded as skipped unless separately authorized.

## 4. Validation And Done Criteria

- [x] **Lint/Format:** No lint script exists; `git diff --check` passes for Phase A.
- [x] **Typecheck:** `npm run typecheck` passes for Phase A.
- [x] **Focused Tests:** The Slice 0 command passes 128/128 after RED/GREEN and review repairs.
- [x] **Full Tests:** Phase A checkpoint `npm test` passes 711/711; Phase B must repeat this after graph cutover and migration.
- [x] **Architecture Check:** Phase A owners/import direction were verified against `docs/deep-dive.md` and the runner-owned-loop ADR by cleanup and integrator reviews; no dedicated script exists.
- [ ] **Package Proof:** Phase A `npm pack --dry-run --json` and extracted 456-file bridge-manifest proof pass. Blocked: the conflicting-skill/no-Python temp consumer proof belongs to the unavailable structural bundle in Phase B.
- [ ] **Real Local Contract:** Blocked: app-server, package runtime home, catalog fixture, and exact CLI `0.144.4` contract are Phase B deliverables and cannot exist before the released-bridge resume gate.
- [ ] **Behavior Proof:** Blocked: manifest graph-node cutover, state-v2 runtime attempts, and migration behavior are Phase B deliverables and cannot exist before the released-bridge resume gate.
- [x] **Live Validation:** `npm run smoke:live` was skipped because it mutates real GitHub state and the user did not separately authorize it.
- [x] **Release/Rollout:** Bridge commit/push/publication, prepared consumer evidence, structural publication, and rollout were not performed; this execution stops at the authorization-bound bridge release hold.
- [x] **Final Reconciliation:** Every unchecked item is Phase B work explicitly blocked by the canonical resume gate; the Phase A Contract Test Ledger entries are green and later entries remain planned.
- [x] **Final Handoff Requirements:** Final response records the Phase A contract, invariants, reviews/repairs, validation, skipped external actions, residual bridge hold, and files by role.

## Implementation Review State

- **Profile / Budget:** `high`; maximum `6`; used `3`; remaining `3`.
- **Review Plan:** One Phase A cleanup Full review; one Phase A bridge integrator Full review covering correctness plus spec/standards and verifying cleanup repairs; one conditional same-session Phase A Closure; one Phase B provenance/concurrency/state checkpoint Full review; one final Phase B cleanup Full review; one final Phase B integrator Full review. The Phase A Closure was consumed; the remaining three slots are reserved exactly for the Phase B reviews.
- **Reserved Mandatory Slots:** Phase A cleanup `1`; Phase A bridge code review `1`; Phase B early checkpoint `1`; Phase B final cleanup `1`; Phase B final integrator `1`. Conditional Closure `1`.
- **Pending Launches:** None.
- **Completed Reviews:** `phase-a-cleanup-1` — Full cleanup review; reviewer/session `019f6686-adf6-78a2-99f1-9f0d513e02f0`; target `phase-a-working-tree@261d2879792f97b91d04f2699e4291ed6e7c4de12fc6a456f36b49f428aecfbb`; outcome `Cleanup Needed`; all assigned cleanup lenses covered. `phase-a-bridge-review-2` — Full bridge integrator review; reviewer/session `019f669f-a430-7813-99d5-d9f7292826ec`; target `phase-a-working-tree@6a07e7ab48f5264f1226c02c1c5b985b0596412d679e53d6fba623d0305cd5a4`; outcome `Needs Work`; reopened `CLEANUP-001`, `CLEANUP-002`, `CLEANUP-003`, verified `CLEANUP-004`, `CLEANUP-005`. `phase-a-bridge-closure-3` — same-session Closure; reviewer/session `019f669f-a430-7813-99d5-d9f7292826ec`; target `phase-a-working-tree@bcfe1da5b33ed5418d8d0e235ab3f6daf5ed636de92564488c71834520c3f012`; outcome `Approved`; no findings; verified all three reopened defects and repair blast radius.
- **Implementation Defect Ledger:** `CLEANUP-001` verified — post-acquire config is authoritative and changed state directories block before reads/mutations; `CLEANUP-002` verified — only target guard uses system-boot semantics while mission locks retain process-nonce behavior; `CLEANUP-003` verified — Darwin raw-command detection fails closed for quoted CLI/target paths with spaces; `CLEANUP-004` verified; `CLEANUP-005` verified.
- **Terminal Outcome:** Phase A Approved. Bridge release hold: bridge-only candidate is reviewed; commit/push/release and consumer preparation require separate authorization. Exactly three review slots remain reserved for Phase B early checkpoint, final cleanup, and final integrator reviews.

## Defect Closure Notes

- **Review Summary:** The maker Module exhausted its original 6/6 high-risk budget (2 Full, 4 Closure, 2 fresh sessions) and ended `Blocked`. The user's later explicit final-review request started a separate standalone Full Adapter review of SHA `090084c96acd7c77e0686a70c4863728f0a6aa7e085a3942960bf736d1d55657`; its first Closure reviewed SHA `928594886f864e24683d9c9829aaa621021a1e37ccd14342be8b3f91f68ebc12`; its final Closure approved substantive SHA `d2deb8724b408405b05b170787fa7198af2fafb81de5438d63c739097d1422cc` with Determinism/Evidence/Validation/Safety `2/2`. The final status fields are lifecycle-only metadata and do not invalidate that approval.
- [x] Every stable Defect Ledger ID is verified, blocked with a concrete reason, or an explicitly accepted execution risk.
- **Verified:** `SPEC-SOURCE-001`, `SPEC-GRAPH-002`, `SPEC-ADAPTER-003`, `SPEC-CONFIG-004`, `SPEC-STATE-005`, `SPEC-BRIDGE-006`, `SPEC-HANDOFF-007`, `SPEC-VALID-008`, `SPEC-MIGRATION-009`, `SPEC-RECOVERY-010`, `SPEC-AUTH-011`, `SPEC-MATERIALIZATION-012`, `SPEC-PLATFORM-013`, `SPEC-HOME-014`, `SPEC-REQUEST-015`, `SPEC-CATALOG-016`, `SPEC-LIFECYCLE-017`, `CLEANUP-001`, `CLEANUP-002`, `CLEANUP-003`, `CLEANUP-004`, `CLEANUP-005`.
- **Fixed, Awaiting Verification:** None.
- **Open Defects:** None.

## 5. Spec-Authoring Final Action

This section is authoring metadata required by `implementation-spec-maker`; it is not an executor step and does not replace the implementation handoff contract in §4.

After saving the file, respond in chat with exactly:

Spec Status: Ready
Saved Path: docs/implementation-specs/2026-07-15/1501-package-owned-skill-runtime.md
Execution Model: Single-Agent
Review Outcome: Approved
Adapter Verdict: Approved
Review Profile: high
Reviews Used: Prior maker loop 6/6 retained; standalone final review used 1 Full and 2 Closures in 1 fresh session
Review Coverage: All mandatory lenses plus affected-contract regression fan-out
Open Defects: None
Validation Gates: Local / Tests / Package Contract; Live and release authorization-bound
Blockers: None
