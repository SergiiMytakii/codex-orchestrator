import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { publishRuntimeAssetSnapshot, verifyRuntimeAssetSnapshot } from '../src/v2/runtime-assets.js';
import {
  ContainedImplementationAgent,
  ContainedProofAgent,
  materializeReportReadView,
  selectedConfiguredCheckPolicySha256,
} from '../src/v2/runtime.js';
import type { AgentAutoConfig } from '../src/v2/config.js';
import { sha256 } from '../src/v2/containment.js';
import {
  extractContainedWorkflowReferences,
  materializeWorkflowGeneration,
  parseWorkflowExecutionProfile,
  sealedWorkflowContentSha256,
  type WorkflowFileRecord,
} from '../src/v2/workflow-assets.js';

const packageRoot = join(import.meta.dirname, '..', '..');
const execFileAsync = promisify(execFile);

test('production proof freshness binds one selected affected check to current two-check authority', () => {
  const authority = { typecheck: 'npm run typecheck', lint: 'npm run lint' };
  const selected = [{ id: 'typecheck', command: 'npm run typecheck' }];
  assert.equal(
    selectedConfiguredCheckPolicySha256(selected, authority),
    sha256('{"typecheck":"npm run typecheck"}'),
  );
  assert.throws(
    () => selectedConfiguredCheckPolicySha256(selected, { ...authority, typecheck: 'npm run typecheck -- --changed' }),
    /current configured authority/u,
  );
});

test('report read view excludes env, denied paths, and symlinks before contained report launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-read-view-'));
  const repository = join(root, 'repository');
  const destination = join(root, 'read-view');
  const absoluteSentinel = join(root, 'absolute-sentinel.txt');
  await mkdir(repository);
  await execFileAsync('git', ['init', '-b', 'main', repository]);
  await writeFile(join(repository, 'README.md'), 'visible\n');
  await writeFile(join(repository, 'removed.txt'), 'remove me\n');
  await writeFile(join(repository, '.env.local'), 'removed\n');
  await writeFile(join(repository, 'denied.txt'), 'removed\n');
  await symlink('/tmp', join(repository, 'outside-link'));
  await writeFile(absoluteSentinel, 'must remain\n');
  await execFileAsync('git', ['-C', repository, 'add', '--all']);
  await execFileAsync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base']);
  await writeFile(join(repository, 'README.md'), 'current checked change\n');
  await writeFile(join(repository, 'untracked.txt'), 'current untracked change\n');
  await rm(join(repository, 'removed.txt'));
  const sourceStatus = (await execFileAsync('git', ['-C', repository, 'status', '--porcelain=v1', '-z'])).stdout;

  await materializeReportReadView({ worktreePath: repository, destination, deniedPaths: ['denied.txt', absoluteSentinel] });

  assert.equal(await readFile(join(destination, 'README.md'), 'utf8'), 'current checked change\n');
  assert.equal(await readFile(join(destination, 'untracked.txt'), 'utf8'), 'current untracked change\n');
  assert.equal(await readFile(absoluteSentinel, 'utf8'), 'must remain\n');
  for (const path of ['.env.local', 'denied.txt', 'outside-link', 'removed.txt']) {
    await assert.rejects(lstat(join(destination, path)), { code: 'ENOENT' });
  }
  assert.equal((await execFileAsync('git', ['-C', repository, 'status', '--porcelain=v1', '-z'])).stdout, sourceStatus);
});

test('report read view rejects a destination inside the source worktree before mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-read-view-overlap-'));
  const repository = join(root, 'repository');
  await mkdir(repository);
  await execFileAsync('git', ['init', '-b', 'main', repository]);
  await writeFile(join(repository, 'README.md'), 'preserved\n');
  await execFileAsync('git', ['-C', repository, 'add', '--all']);
  await execFileAsync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base']);

  await assert.rejects(materializeReportReadView({
    worktreePath: repository,
    destination: join(repository, '.report-read-view'),
    deniedPaths: [],
  }), /overlap/iu);
  const alias = join(root, 'repository-alias');
  await symlink(repository, alias);
  await assert.rejects(materializeReportReadView({
    worktreePath: repository,
    destination: join(alias, '.report-read-view'),
    deniedPaths: [],
  }), /overlap/iu);
  assert.equal(await readFile(join(repository, 'README.md'), 'utf8'), 'preserved\n');
  assert.equal((await execFileAsync('git', ['-C', repository, 'status', '--porcelain=v1'])).stdout, '');
});

test('operation snapshot copies one pinned generation closure and concurrent publishers reuse it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-generation-'));
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'orchestrator'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  const input = {
    workflowGeneration,
    runtimeRoot: join(root, 'runtime'),
    snapshotRelativePath: 'runs/run-a/attempts/attempt-a/snapshot',
    operation: 'acceptance-proof',
    bootId: 'boot-a',
  };
  const snapshots = await Promise.all(Array.from({ length: 16 }, async () => publishRuntimeAssetSnapshot(input)));
  const [left, right] = snapshots;
  assert.ok(left && right);
  assert.equal(left.snapshotRoot, right.snapshotRoot);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.snapshotRoot)).size, 1);
  assert.equal(left.generationHash, workflowGeneration.generationHash);
  assert.equal(left.operation, 'acceptance-proof');
  assert.equal(left.policy.runnerPostcondition, 'proof-only');
  assert.match(left.operationPath, /operations\/acceptance-proof\/SKILL\.md$/u);
  assert.match(left.schemaPath, /schemas\/proof-report-v1\.json$/u);
  assert.equal(left.files.some((file) => file.path.endsWith('tools/android-lease.mjs')), false);
  const profile = parseWorkflowExecutionProfile(await readFile(left.profilePath, 'utf8'), left.policy);
  assert.equal(profile.name, 'implementer');
  assert.equal(profile.model, 'gpt-5.6-sol');
  assert.equal(profile.reasoningEffort, 'medium');
  await verifyRuntimeAssetSnapshot(left);
});

test('implementation snapshot carries the bug workflow documents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-implementation-closure-'));
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'orchestrator'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  const snapshot = await publishRuntimeAssetSnapshot({
    workflowGeneration,
    runtimeRoot: join(root, 'runtime'),
    snapshotRelativePath: 'runs/run-a/attempts/implementation/snapshot',
    operation: 'implementation',
    bootId: 'boot-a',
  });

  for (const path of [
    'docs/agents/bug-workflow-routing.md',
    'docs/agents/bugfix-quality-gate.md',
    'docs/agents/confidence-rubric.md',
  ]) assert.equal(snapshot.referencedDocumentPaths.includes(path), true, path);
  await verifyRuntimeAssetSnapshot(snapshot);
});

test('operation snapshots resolve contained references and complete referenced skill closures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-reference-closure-'));
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'orchestrator'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  const manifest = JSON.parse(await readFile(join(packageRoot, 'internal-workflow', 'manifest.json'), 'utf8')) as {
    operations: Record<string, unknown>;
    skills: Record<string, { entry: string; files: string[] }>;
  };

  for (const operation of Object.keys(manifest.operations)) {
    const snapshot = await publishRuntimeAssetSnapshot({
      workflowGeneration,
      runtimeRoot: join(root, 'runtime'),
      snapshotRelativePath: `runs/run-a/attempts/${operation}/snapshot`,
      operation,
      bootId: 'boot-a',
    });
    const files = new Set(snapshot.files.map((file) => file.path));
    for (const file of snapshot.files) {
      if (!/\.(?:md|json|yaml|yml|toml|mjs|txt)$/iu.test(file.path)) continue;
      const text = await readFile(join(snapshot.snapshotRoot, ...file.path.split('/')), 'utf8');
      for (const referenced of extractContainedWorkflowReferences(file.path, text)) {
        assert.equal(files.has(referenced), true, `${operation}: unresolved ${file.path} -> ${referenced}`);
      }
      for (const match of text.matchAll(/`([a-z][a-z0-9-]*)`|\$([a-z][a-z0-9-]*)/gu)) {
        const skillId = match[1] ?? match[2]!;
        const skill = manifest.skills[skillId];
        if (!skill) continue;
        for (const path of skill.files) {
          assert.equal(files.has(path), true, `${operation}: incomplete referenced skill ${skillId}: ${path}`);
        }
      }
    }
    await verifyRuntimeAssetSnapshot(snapshot);
  }
});

test('contained Android proof receives only Runner-prepared evidence and no host mutation authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-android-proof-prompt-'));
  const orchestratorHome = join(root, 'orchestrator');
  const targetRoot = join(root, 'target');
  const worktree = join(targetRoot, '.codex-orchestrator/worktrees/issue-177');
  const candidateWorktree = join(targetRoot, '.codex-orchestrator/worktrees/.candidate-executions/run/binding/proof');
  await mkdir(worktree, { recursive: true });
  await mkdir(candidateWorktree, { recursive: true });
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: orchestratorHome,
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  let prompt = '';
  let proofCwd = '';
  let launchPersisted = false;
  let processRuns = 0;
  const process = {
    run: async (invocation: { prompt: string; cwd: string; onSpawned?: (input: { pid: number; processGroupId: number }) => Promise<void> }) => {
      processRuns += 1;
      prompt = invocation.prompt;
      proofCwd = invocation.cwd;
      await invocation.onSpawned?.({ pid: 177, processGroupId: 177 });
      return { kind: 'cancelled' as const };
    },
  };
  const agent = new ContainedProofAgent({
    config: androidConfigFixture,
    orchestratorHome,
    parentCodexHome: join(root, 'codex-home'),
    safePath: '/usr/bin:/bin',
    targetRoot,
    bootId: 'boot-a',
    androidAdbPath: '/android-sdk/platform-tools/adb',
    iosXcrunPath: '/usr/bin/xcrun',
    processExecutor: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
    process: process as never,
    createAttemptId: () => 'attempt-android-proof',
  });
  const result = await agent.run({
    attemptId: 'attempt-android-proof',
    proofId: 'proof-177',
    runId: 'run-177',
    issue: { number: 177, title: 'Android screen', body: 'Open Live.', url: 'https://example.invalid/177', state: 'OPEN', labels: [] },
    frozenCriteria: [{ id: 'ac-1', order: 1, source: 'explicit', text: 'Android Live renders.' }],
    checkedChangeSha256: 'a'.repeat(64),
    changedFiles: ['test/widget_test.dart'],
    checks: [],
    worktreePath: candidateWorktree,
    onLaunched: async ({ pid, processGroupId }) => { launchPersisted = pid === 177 && processGroupId === 177; },
    runnerPreparedArtifactPaths: ['.codex-orchestrator/v2/proofs/proof-177/android-runner-receipt.json'],
    runnerPreparedArtifactSha256: { '.codex-orchestrator/v2/proofs/proof-177/android-runner-receipt.json': 'b'.repeat(64) },
    runnerPreparationWarnings: ['Android UI proof unfinished: emulator boot timed out.'],
    repairOnly: false,
    repairFindings: [],
    workflowGeneration,
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'cancelled');
  assert.equal(proofCwd, candidateWorktree);
  assert.equal(launchPersisted, true);
  assert.match(prompt, /Runner-owned Android artifact paths/u);
  assert.match(prompt, /Do not invoke adb, emulator, Flutter run, or an Android lease helper/u);
  assert.match(prompt, /Android UI proof unfinished: emulator boot timed out/u);
  assert.match(prompt, /Android infrastructure failure alone must not block delivery/u);
  assert.doesNotMatch(prompt, /Android lease root:/u);
  assert.doesNotMatch(prompt, /Android adb path:/u);

  const recoveredAttemptId = 'attempt-android-proof';
  const recoveredReportPath = join(
    orchestratorHome, 'v2', sha256('m-ivonin/tipsterbro'), 'runs', 'run-177', 'attempts', recoveredAttemptId, 'report.json',
  );
  await writeFile(recoveredReportPath, '{"version":1,"status":"external-block"}\n');
  const recovered = await agent.run({
    attemptId: recoveredAttemptId,
    proofId: 'proof-177', runId: 'run-177',
    issue: { number: 177, title: 'Android screen', body: 'Open Live.', url: 'https://example.invalid/177', state: 'OPEN', labels: [] },
    frozenCriteria: [{ id: 'ac-1', order: 1, source: 'explicit', text: 'Android Live renders.' }],
    checkedChangeSha256: 'a'.repeat(64), changedFiles: ['test/widget_test.dart'], checks: [],
    worktreePath: candidateWorktree, runnerPreparedArtifactPaths: [], runnerPreparedArtifactSha256: {},
    runnerPreparationWarnings: [], repairOnly: false, repairFindings: [], workflowGeneration,
    signal: new AbortController().signal,
  });
  assert.equal(recovered.kind, 'report');
  assert.equal(processRuns, 1);

  await unlink(recoveredReportPath);
  const missingRecovery = await agent.run({
    attemptId: recoveredAttemptId,
    recoverOnly: true,
    proofId: 'proof-177', runId: 'run-177',
    issue: { number: 177, title: 'Android screen', body: 'Open Live.', url: 'https://example.invalid/177', state: 'OPEN', labels: [] },
    frozenCriteria: [{ id: 'ac-1', order: 1, source: 'explicit', text: 'Android Live renders.' }],
    checkedChangeSha256: 'a'.repeat(64), changedFiles: ['test/widget_test.dart'], checks: [],
    worktreePath: candidateWorktree, runnerPreparedArtifactPaths: [], runnerPreparedArtifactSha256: {},
    runnerPreparationWarnings: [], repairOnly: false, repairFindings: [], workflowGeneration,
    signal: new AbortController().signal,
  });
  assert.equal(missingRecovery.kind, 'internal-error');
  assert.equal(processRuns, 1);
});

test('contained implementation and proof map a settled launch-gate failure to resumable infrastructure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-launch-gate-resume-'));
  const orchestratorHome = join(root, 'orchestrator');
  const targetRoot = join(root, 'target');
  const worktree = join(targetRoot, '.worktrees', 'issue-42');
  await mkdir(worktree, { recursive: true });
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot, runtimeRoot: orchestratorHome, packageVersion: '2.0.1', bootId: 'boot-a',
  });
  let implementationPrompt = '';
  const process = {
    run: async (invocation: { prompt?: string; onSpawned?: (input: { pid: number; processGroupId: number }) => Promise<void> }) => {
      implementationPrompt = invocation.prompt ?? '';
      await invocation.onSpawned?.({ pid: 4242, processGroupId: 4242 });
      return { kind: 'launch-gate-failed' as const };
    },
  };
  const freshness = {
    headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
    untrackedContentSha256: '4'.repeat(64), worktreeIdentity: 'fixture-worktree',
  };
  const implementation = new ContainedImplementationAgent({
    config: androidConfigFixture, orchestratorHome, parentCodexHome: join(root, 'codex-home'),
    safePath: '/usr/bin:/bin', bootId: 'boot-a', git: { snapshot: async () => freshness } as never,
    process: process as never,
  });
  const implementationResult = await implementation.run({
    operation: 'implementation', attemptId: 'implementation-launch-gate', runId: 'run-42', worktreePath: worktree,
    issue: { number: 42, title: 'Issue', body: '', url: 'https://example.invalid/42', state: 'OPEN', labels: [] },
    frozenCriteria: [{ id: 'ac-1', order: 1, source: 'explicit', text: 'Works.' }],
    deliveryAuthority: {
      version: 2, kind: 'issue', issueNumber: 42, issueUrl: 'https://example.invalid/42',
      issueSnapshotSha256: '5'.repeat(64), authorizationLabel: 'agent:auto', sourceSha256: '5'.repeat(64), authoritySha256: '6'.repeat(64),
    },
    cycle: 1, reworkFindings: [], repairOnly: false, workflowGeneration,
    reviewFeedbackRound: 1,
    reviewFeedback: [{
      id: 'issue-comment:105', sourceUrl: 'https://github.com/owner/repo/issues/42#issuecomment-105',
      path: null, line: null, body: 'Why does this work?',
    }],
    reviewFeedbackPullRequest: {
      number: 17, headSha: '1'.repeat(40), headRefName: 'codex/issue-42', url: 'https://github.com/owner/repo/pull/17',
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(implementationResult, { kind: 'transport-failed', resumable: true });
  assert.match(implementationPrompt, /Frozen trusted feedback:.*issue-comment:105/u);
  assert.match(implementationPrompt, /Current same-branch draft pull request:.*codex\/issue-42/u);
  assert.match(implementationPrompt, /in-scope repair/u);
  assert.match(implementationPrompt, /answer-only/u);
  assert.match(implementationPrompt, /return boundary/u);

  const proof = new ContainedProofAgent({
    config: androidConfigFixture, orchestratorHome, parentCodexHome: join(root, 'codex-home'), safePath: '/usr/bin:/bin',
    targetRoot, bootId: 'boot-a', androidAdbPath: '/android/adb', iosXcrunPath: '/usr/bin/xcrun',
    processExecutor: async () => ({ stdout: '', stderr: '', exitCode: 1 }), process: process as never,
  });
  const proofResult = await proof.run({
    attemptId: 'proof-launch-gate', proofId: 'proof-42', runId: 'run-42',
    issue: { number: 42, title: 'Issue', body: '', url: 'https://example.invalid/42', state: 'OPEN', labels: [] },
    frozenCriteria: [{ id: 'ac-1', order: 1, source: 'explicit', text: 'Works.' }],
    checkedChangeSha256: '7'.repeat(64), changedFiles: ['feature.txt'], checks: [], worktreePath: worktree,
    runnerPreparedArtifactPaths: [], runnerPreparedArtifactSha256: {}, runnerPreparationWarnings: [],
    repairOnly: false, repairFindings: [], workflowGeneration, signal: new AbortController().signal,
  });
  assert.deepEqual(proofResult, { kind: 'transport-failed', resumable: true });
});

test('operation snapshot fails closed on tamper, path escape, and undeclared operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-negative-'));
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'orchestrator'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  const common = { workflowGeneration, runtimeRoot: join(root, 'runtime'), bootId: 'boot-a' };
  await assert.rejects(publishRuntimeAssetSnapshot({
    ...common, snapshotRelativePath: '../snapshot', operation: 'implementation',
  }), /snapshotRelativePath|invalid/iu);
  await assert.rejects(publishRuntimeAssetSnapshot({
    ...common, snapshotRelativePath: 'runs/a/attempts/a/snapshot', operation: 'unknown',
  }), /unavailable/iu);
  const snapshot = await publishRuntimeAssetSnapshot({
    ...common, snapshotRelativePath: 'runs/b/attempts/b/snapshot', operation: 'implementation',
  });
  const entry = snapshot.operationPath;
  await chmod(entry, 0o600);
  await writeFile(entry, '# tampered\n');
  await chmod(entry, 0o400);
  await assert.rejects(verifyRuntimeAssetSnapshot(snapshot), /hash|evidence|drift/iu);
});

test('operation snapshot rejects self-consistent closures missing derived skills or documents', async () => {
  const closure = {
    skillPaths: ['skills/alpha/SKILL.md', 'skills/beta/SKILL.md'],
    referencedDocumentPaths: ['docs/agents/policy.md', 'docs/agents/tool-usage.md'],
  };
  for (const missing of [...closure.skillPaths, ...closure.referencedDocumentPaths]) {
    const snapshot = await manualRuntimeSnapshot('alpha', closure);
    await verifyRuntimeAssetSnapshot(snapshot);
    await chmod(join(snapshot.snapshotRoot, ...missing.split('/').slice(0, -1)), 0o755);
    await unlink(join(snapshot.snapshotRoot, ...missing.split('/')));
    await chmod(join(snapshot.snapshotRoot, ...missing.split('/').slice(0, -1)), 0o555);
    snapshot.files = snapshot.files.filter((file) => file.path !== missing);
    snapshot.contentSha256 = runtimeContentSha256(snapshot.files);
    await assert.rejects(verifyRuntimeAssetSnapshot(snapshot), /dependency skill|referenced document|closure/iu, missing);
  }
});

test('runtime verifier rejects removal of Markdown, inline, and workflow-root references', async () => {
  const referencedDocumentPaths = [
    'docs/agents/inline.md',
    'docs/agents/markdown.md',
    'docs/agents/root.md',
  ];
  const operationText = [
    '[markdown](../../docs/agents/markdown.md)',
    'Apply `../../docs/agents/inline.md`.',
    'Use `$CODEX_ORCHESTRATOR_WORKFLOW_ROOT/docs/agents/root.md`.',
    '',
  ].join('\n');
  for (const missing of referencedDocumentPaths) {
    const snapshot = await manualRuntimeSnapshot('alpha', {
      skillPaths: [],
      referencedDocumentPaths,
    }, operationText);
    await verifyRuntimeAssetSnapshot(snapshot);
    const absolute = join(snapshot.snapshotRoot, ...missing.split('/'));
    await chmod(join(absolute, '..'), 0o755);
    await unlink(absolute);
    await chmod(join(absolute, '..'), 0o555);
    snapshot.files = snapshot.files.filter((file) => file.path !== missing);
    snapshot.referencedDocumentPaths = snapshot.referencedDocumentPaths.filter((path) => path !== missing);
    snapshot.contentSha256 = runtimeContentSha256(snapshot.files);

    await assert.rejects(verifyRuntimeAssetSnapshot(snapshot), /referenced workflow path is missing/iu, missing);
  }
});

test('runtime verifier applies every skill binding form and ignores fenced examples', async (t) => {
  const forms = [
    '$beta',
    '[beta](<../../skills/beta/SKILL.md#usage> "Beta title")',
    '`../../skills/beta/SKILL.md#usage`',
    '`$CODEX_ORCHESTRATOR_WORKFLOW_ROOT/skills/beta/SKILL.md#usage`',
  ];
  for (const [index, reference] of forms.entries()) {
    await t.test(`form-${index + 1}`, async () => {
      const snapshot = await manualRuntimeSnapshot('alpha', {
        skillPaths: ['skills/beta/SKILL.md'],
        referencedDocumentPaths: [],
      }, `${reference}\n`);
      await verifyRuntimeAssetSnapshot(snapshot);
      const skill = join(snapshot.snapshotRoot, 'skills', 'beta', 'SKILL.md');
      await chmod(join(skill, '..'), 0o755);
      await unlink(skill);
      await chmod(join(skill, '..'), 0o555);
      snapshot.files = snapshot.files.filter((file) => file.path !== 'skills/beta/SKILL.md');
      snapshot.skillPaths = [];
      snapshot.contentSha256 = runtimeContentSha256(snapshot.files);
      await assert.rejects(verifyRuntimeAssetSnapshot(snapshot), /referenced (?:workflow path|skill closure) is missing/iu);
    });
  }

  const fenced = await manualRuntimeSnapshot('alpha', {
    skillPaths: [],
    referencedDocumentPaths: [],
  }, '```md\nUse `$beta` or [beta](../../skills/beta/SKILL.md).\n```\n');
  await verifyRuntimeAssetSnapshot(fenced);
});

test('operation snapshot rejects self-consistent removal of referenced bug workflow documents', async () => {
  const affected = {
    implementation: [
      'docs/agents/bug-workflow-routing.md',
      'docs/agents/bugfix-quality-gate.md',
      'docs/agents/confidence-rubric.md',
    ],
  } as const;
  for (const [operation, paths] of Object.entries(affected)) {
    for (const missing of paths) {
      const root = await mkdtemp(join(tmpdir(), `runtime-assets-${operation}-tamper-`));
      const workflowGeneration = await materializeWorkflowGeneration({
        packageRoot,
        runtimeRoot: join(root, 'orchestrator'),
        packageVersion: '2.0.1',
        bootId: 'boot-a',
      });
      const snapshot = await publishRuntimeAssetSnapshot({
        workflowGeneration,
        runtimeRoot: join(root, 'runtime'),
        snapshotRelativePath: `runs/run-a/attempts/${operation}/snapshot`,
        operation,
        bootId: 'boot-a',
      });
      const absolute = join(snapshot.snapshotRoot, ...missing.split('/'));
      await chmod(join(absolute, '..'), 0o755);
      await unlink(absolute);
      await chmod(join(absolute, '..'), 0o555);
      snapshot.files = snapshot.files.filter((file) => file.path !== missing);
      snapshot.referencedDocumentPaths = snapshot.referencedDocumentPaths.filter((path) => path !== missing);
      snapshot.contentSha256 = runtimeContentSha256(snapshot.files);

      await assert.rejects(verifyRuntimeAssetSnapshot(snapshot), /referenced workflow path is missing/iu, `${operation}: ${missing}`);
    }
  }
});

test('operation snapshot rejects a runtime root below a symlinked ancestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assets-ancestor-symlink-'));
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot,
    runtimeRoot: join(root, 'orchestrator'),
    packageVersion: '2.0.1',
    bootId: 'boot-a',
  });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'linked-parent'), 'dir');
  await assert.rejects(publishRuntimeAssetSnapshot({
    workflowGeneration,
    runtimeRoot: join(root, 'linked-parent', 'runtime'),
    snapshotRelativePath: 'runs/run-a/attempts/attempt-a/snapshot',
    operation: 'implementation',
    bootId: 'boot-a',
  }), /root is unsafe/iu);
  await assert.rejects(lstat(join(outside, 'runtime')), { code: 'ENOENT' });
});

test('operation snapshot converges after publisher process death at every ready boundary', { timeout: 180_000 }, async () => {
  const modulePath = join(packageRoot, 'dist', 'src', 'v2', 'runtime-assets.js');
  for (const step of [
    'before-claim-link', 'after-claim-link', 'after-content-mkdir', 'after-first-content-file',
    'before-content-parent-sync', 'after-content-parent-sync', 'before-ready-link',
    'after-ready-link', 'after-ready-parent-sync',
  ]) {
    const root = await mkdtemp(join(tmpdir(), `runtime-assets-kill-${step}-`));
    const workflowGeneration = await materializeWorkflowGeneration({
      packageRoot, runtimeRoot: join(root, 'orchestrator'), packageVersion: '2.0.1', bootId: 'parent',
    });
    const input = {
      workflowGeneration,
      runtimeRoot: join(root, 'runtime'),
      snapshotRelativePath: 'runs/run-a/attempts/attempt-a/snapshot',
      operation: 'implementation',
      bootId: 'killed-child',
    };
    const script = `
      import { publishRuntimeAssetSnapshot } from ${JSON.stringify(new URL(`file://${modulePath}`).href)};
      await publishRuntimeAssetSnapshot({ ...${JSON.stringify(input)},
        onStep(value) { if (value === ${JSON.stringify(step)}) process.kill(process.pid, 'SIGKILL'); }
      });
    `;
    const killed = await spawnResult(process.execPath, ['--input-type=module', '--eval', script]);
    assert.equal(killed.signal, 'SIGKILL', step);
    const snapshot = await publishRuntimeAssetSnapshot({ ...input, bootId: 'recovery-parent' });
    await verifyRuntimeAssetSnapshot(snapshot);
  }
});

async function spawnResult(file: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(file, args, { stdio: 'ignore' });
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function manualRuntimeSnapshot(operation: string, closure: {
  skillPaths: string[];
  referencedDocumentPaths: string[];
}, operationText?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `runtime-assets-mandatory-${operation}-`)));
  const runtimeRoot = join(root, 'runtime');
  const snapshotRoot = join(runtimeRoot, 'snapshot');
  const paths = [
    `operations/${operation}/SKILL.md`,
    `schemas/${operation}.json`,
    'profiles/fixture.toml',
    ...closure.skillPaths,
    ...closure.skillPaths.map((path) => path.replace(/\/SKILL\.md$/u, '/agents/openai.yaml')),
    ...closure.referencedDocumentPaths,
  ].sort();
  const files = [];
  for (const path of paths) {
    const absolute = join(snapshotRoot, ...path.split('/'));
    await mkdir(join(absolute, '..'), { recursive: true, mode: 0o755 });
    const bytes = Buffer.from(path === `operations/${operation}/SKILL.md` && operationText !== undefined
      ? operationText
      : `${path}\n`);
    await writeFile(absolute, bytes, { mode: 0o444 });
    files.push({
      path,
      mode: 0o644,
      size: bytes.length,
      sha256: sha256(bytes),
      sealedMode: 0o444,
      ownerUid: process.getuid!(),
    });
  }
  const directories = new Set([snapshotRoot]);
  for (const path of paths) {
    let current = snapshotRoot;
    for (const segment of path.split('/').slice(0, -1)) {
      current = join(current, segment);
      directories.add(current);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) await chmod(directory, 0o555);
  return {
    packageVersion: 'fixture',
    generationHash: 'a'.repeat(64),
    operation,
    runtimeRoot,
    snapshotRoot,
    operationPath: join(snapshotRoot, 'operations', operation, 'SKILL.md'),
    skillPaths: closure.skillPaths,
    referencedDocumentPaths: closure.referencedDocumentPaths,
    schemaPath: join(snapshotRoot, 'schemas', `${operation}.json`),
    profilePath: join(snapshotRoot, 'profiles', 'fixture.toml'),
    reviewerProfiles: {},
    policy: {
      sandboxMode: 'workspace-write' as const, cwdClass: 'worktree' as const, worktreeAccess: 'write' as const,
      writableRootClasses: ['worktree' as const], runnerPostcondition: 'change-set' as const, network: 'deny' as const,
      networkHosts: [], mcpTools: [], approvalCeiling: 'never' as const, externalWrite: false as const,
    },
    ownerUid: process.getuid!(),
    files: files as Array<WorkflowFileRecord & { sealedMode: number; ownerUid: number }>,
    contentSha256: runtimeContentSha256(files),
    reused: false,
  };
}

function runtimeContentSha256(files: Array<{ path: string; sealedMode: number; size: number; sha256: string }>): string {
  return sealedWorkflowContentSha256(files.map(({ path, sealedMode, size, sha256 }) => ({ path, sealedMode, size, sha256 })));
}

function androidConfigFixture(): AgentAutoConfig {
  return {
    schema: 'codex-orchestrator.agent-auto', version: 2,
    github: {
      owner: 'M-Ivonin', repo: 'tipsterBro', baseBranch: 'sirbro-dev',
      labels: {
        auto: { name: 'agent:auto', color: '000000', description: 'auto' },
        running: { name: 'agent:running', color: '000001', description: 'running' },
        blocked: { name: 'agent:blocked', color: '000002', description: 'blocked' },
        review: { name: 'agent:review', color: '000003', description: 'review' },
      },
    },
    runner: {
      workspaceRoot: '.codex-orchestrator/worktrees', stateDir: '.codex-orchestrator/state',
      branchTemplate: 'codex/issue-${issueNumber}', pollIntervalSeconds: 30,
    },
    codex: { command: '/usr/bin/false', timeoutMs: 60_000, idleTimeoutMs: 30_000, toolNetwork: 'deny' },
    checks: {},
    proof: {
      artifactDir: '.codex-orchestrator/v2/proofs',
      android: {
        applicationId: 'ai.levantem.sirbro', avdName: 'Pixel_9_API_Baklava',
        flutterCommand: '/opt/flutter/bin/flutter', buildArgs: ['build', 'apk'], apkPath: 'build/app.apk',
        tapText: ['Live'], bootTimeoutMs: 180_000, navigationTimeoutMs: 60_000, settleMs: 5_000,
      },
    },
    deny: { readPaths: ['.env'], commands: ['/usr/bin/env'] },
  };
}
