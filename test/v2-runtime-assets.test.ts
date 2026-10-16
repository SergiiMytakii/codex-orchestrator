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
  materializeReportReadView,
  configuredCheckPolicySha256,
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

test('production proof freshness requires the entire current configured check authority', () => {
  const authority = { typecheck: 'npm run typecheck', lint: 'npm run lint' };
  const passed = [
    { id: 'typecheck', command: 'npm run typecheck' },
    { id: 'lint', command: 'npm run lint' },
  ];
  assert.equal(configuredCheckPolicySha256(passed, authority), sha256('{"lint":"npm run lint","typecheck":"npm run typecheck"}'));
  assert.throws(() => configuredCheckPolicySha256(passed.slice(0, 1), authority), /every mandatory/u);
  assert.throws(() => configuredCheckPolicySha256(passed, { ...authority, build: 'npm run build' }), /every mandatory/u);
  assert.throws(() => configuredCheckPolicySha256(passed, { ...authority, typecheck: 'npm run typecheck -- --changed' }), /current configured authority/u);
  assert.throws(() => configuredCheckPolicySha256([...passed, passed[0]!], authority), /current configured authority/u);
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
    operation: 'implementation',
    bootId: 'boot-a',
  };
  const snapshots = await Promise.all(Array.from({ length: 16 }, async () => publishRuntimeAssetSnapshot(input)));
  const [left, right] = snapshots;
  assert.ok(left && right);
  assert.equal(left.snapshotRoot, right.snapshotRoot);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.snapshotRoot)).size, 1);
  assert.equal(left.generationHash, workflowGeneration.generationHash);
  assert.equal(left.operation, 'implementation');
  assert.equal(left.policy.runnerPostcondition, 'change-set');
  assert.match(left.operationPath, /operations\/implementation\/SKILL\.md$/u);
  assert.match(left.schemaPath, /schemas\/implementation-report-v1\.json$/u);
  assert.equal(left.files.some((file) => file.path.endsWith('tools/android-lease.mjs')), false);
  const profile = parseWorkflowExecutionProfile(await readFile(left.profilePath, 'utf8'), left.policy);
  assert.equal(profile.name, 'implementer');
  assert.equal(profile.model, 'gpt-6.1-sol');
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

test('one contained owner receives proof, independent Review, session identity, and durable launch authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-owner-prompt-'));
  const orchestratorHome = join(root, 'orchestrator');
  const worktree = join(root, 'worktree');
  await mkdir(worktree);
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot, runtimeRoot: orchestratorHome, packageVersion: '2.0.1', bootId: 'boot-a',
  });
  const sessionId = '019a1435-06c0-7860-8f62-b1faadb9662b';
  const persistedSessions: string[] = [];
  let launchPersisted = false;
  let processRuns = 0;
  const process = { run: async (invocation: any) => {
    processRuns++;
    assert.equal(invocation.cwd, worktree);
    assert.equal(invocation.sessionId, sessionId);
    await invocation.onSessionStarted(sessionId);
    await invocation.onSpawned({ pid: 177, processGroupId: 177 });
    assert.equal(invocation.operationPolicy.sandboxMode, 'workspace-write');
    assert.equal(invocation.operationPolicy.runnerPostcondition, 'change-set');
    assert.equal(invocation.operationPolicy.approvalCeiling, 'never');
    assert.equal(invocation.operationPolicy.externalWrite, false);
    assert.match(invocation.prompt, /Proof artifacts belong under \.codex-orchestrator\/v2\/proofs\/proof-177\//u);
    assert.match(invocation.prompt, /Complete proof and independent Review through the packaged global skills/u);
    assert.match(invocation.prompt, /Run heavy checks sequentially/u);
    assert.match(invocation.prompt, /Do not commit, push, publish/u);
    assert.match(invocation.prompt, /Android Live renders/u);
    assert.deepEqual(Object.keys(invocation.agentProfilePaths).sort(), ['implementer', 'spec_reviewer', 'standards_reviewer']);
    for (const profile of Object.values(invocation.agentProfilePaths)) await readFile(profile as string, 'utf8');
    const schema = JSON.parse(await readFile(invocation.schemaPath, 'utf8'));
    assert.ok(schema.properties);
    return { kind: 'cancelled' as const };
  } };
  const agent = new ContainedImplementationAgent({
    config: androidConfigFixture, orchestratorHome, parentCodexHome: join(root, 'codex-home'),
    safePath: '/usr/bin:/bin', bootId: 'boot-a', process: process as never,
    git: { snapshot: async () => runtimeFreshness() } as never,
  });
  const input = {
    ...ownerInput(worktree, workflowGeneration), attemptId: 'owner-177', proofId: 'proof-177', sessionId,
    frozenCriteria: [{ id: 'ac-1', order: 1, source: 'explicit' as const, text: 'Android Live renders.' }],
    onSessionStarted: async (id: string) => { persistedSessions.push(id); },
    onLaunched: async ({ pid, processGroupId }: { pid: number; processGroupId: number }) => { launchPersisted = pid === 177 && processGroupId === 177; },
  };
  assert.deepEqual(await agent.run(input), { kind: 'cancelled' });
  assert.equal(launchPersisted, true);
  assert.deepEqual(persistedSessions, [sessionId]);
  const reportPath = join(orchestratorHome, 'v2', sha256('m-ivonin/tipsterbro'), 'runs', input.runId, 'attempts', input.attemptId, 'report.json');
  const reportBytes = Buffer.from('{"version":1,"status":"external-block"}\n');
  await writeFile(reportPath, reportBytes);
  const recovered = await agent.run(input);
  assert.equal(recovered.kind, 'completed');
  if (recovered.kind !== 'completed') assert.fail('Expected exact persisted owner report recovery');
  assert.deepEqual(recovered.reportBytes, reportBytes);
  assert.equal(processRuns, 1);
});

test('contained owner maps settled infrastructure failures to resumable outcomes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-launch-gate-resume-'));
  const orchestratorHome = join(root, 'orchestrator');
  const targetRoot = join(root, 'target');
  const worktree = join(targetRoot, '.worktrees', 'issue-42');
  await mkdir(worktree, { recursive: true });
  const workflowGeneration = await materializeWorkflowGeneration({
    packageRoot, runtimeRoot: orchestratorHome, packageVersion: '2.0.1', bootId: 'boot-a',
  });
  let implementationPrompt = '';
  let processResult = { kind: 'launch-gate-failed', exitCode: null as number | null, signal: null as string | null, stderr: Buffer.alloc(0), report: { kind: 'missing' } };
  const process = {
    run: async (invocation: { prompt?: string; onSpawned?: (input: { pid: number; processGroupId: number }) => Promise<void> }) => {
      implementationPrompt = invocation.prompt ?? '';
      await invocation.onSpawned?.({ pid: 4242, processGroupId: 4242 });
      return processResult;
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
    operation: 'implementation', proofId: 'proof-42', attemptId: 'implementation-launch-gate', runId: 'run-42', worktreePath: worktree,
    issue: { number: 42, title: 'Issue', body: 'Detailed ticket: preserve the existing public contract and save verification output to the requested local artifact.', url: 'https://example.invalid/42', state: 'OPEN', labels: [] },
    frozenCriteria: [{ id: 'ac-1', order: 1, source: 'explicit', text: 'Works.' }],
    deliveryAuthority: {
      version: 2, kind: 'issue', issueNumber: 42, issueUrl: 'https://example.invalid/42',
      issueSnapshotSha256: '5'.repeat(64), authorizationLabel: 'agent:auto', sourceSha256: '5'.repeat(64), authoritySha256: '6'.repeat(64),
    },
    cycle: 1, reworkFindings: [], workflowGeneration,
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
  const sourceSkill = implementationPrompt.match(/^Process authority: (.+)$/mu)?.[1];
  assert.ok(sourceSkill, 'Launch must identify the imported process authority');
  assert.equal(await readFile(sourceSkill, 'utf8'),
    await readFile(join(packageRoot, 'internal-workflow/skills/implement/SKILL.md'), 'utf8'));
  const workflowRoot = implementationPrompt.match(/^The operation's immutable workflow root is (.+)\.$/mu)?.[1];
  assert.ok(workflowRoot);
  assert.equal(sourceSkill, join(workflowRoot, 'skills/implement/SKILL.md'));

  assert.ok(implementationPrompt.includes('Detailed ticket: preserve the existing public contract and save verification output to the requested local artifact.'));
  assert.match(implementationPrompt, /Frozen trusted feedback:.*issue-comment:105/u);
  assert.match(implementationPrompt, /Current same-branch draft pull request:.*codex\/issue-42/u);
  assert.match(implementationPrompt, /in-scope repair/u);
  assert.match(implementationPrompt, /answer-only/u);
  assert.match(implementationPrompt, /return boundary/u);
  assert.match(implementationPrompt, /complete current candidate diff relative to the original HEAD/u);
  assert.match(implementationPrompt, /verification-only repair with no new edits still returns completed/u);

  for (const kind of ['idle-timeout', 'timeout', 'transport-failed', 'spawn-failed']) {
    processResult = { kind, exitCode: 1, signal: 'SIGTERM', stderr: Buffer.from('stream disconnected before completion'), report: { kind: 'missing' } };
    const result = await implementation.run({ ...ownerInput(worktree, workflowGeneration), attemptId: `owner-${kind}` });
    assert.deepEqual(result, { kind: 'transport-failed', resumable: true });
  }
  processResult = Object.assign({ kind: 'transport-failed', exitCode: 0, signal: null, stderr: Buffer.alloc(0), report: { kind: 'missing' } }, { error: 'session CAS rejected' });
  assert.deepEqual(await implementation.run({ ...ownerInput(worktree, workflowGeneration), attemptId: 'owner-session-persistence-failure' }),
    { kind: 'transport-failed', resumable: true });
  processResult = Object.assign({ kind: 'transport-failed', exitCode: 0, signal: null, stderr: Buffer.alloc(0), report: { kind: 'missing' } },
    { error: 'session CAS rejected', sessionIdentityFailed: true });
  assert.deepEqual(await implementation.run({ ...ownerInput(worktree, workflowGeneration), attemptId: 'owner-session-identity-failure' }),
    { kind: 'internal-error' });
  for (const diagnostic of ['Selected model is at capacity. Please try a different model.', 'x'.repeat(2000) + ' token=credential-material-12345', 'ENOENT /Users/example/private/auth.json', 'plain\n' + 'x'.repeat(2000)]) {
    processResult = { kind: 'transport-failed', exitCode: 1, signal: null, stderr: Buffer.from(diagnostic), report: { kind: 'missing' } };
    const result = await implementation.run({ ...ownerInput(worktree, workflowGeneration), attemptId: `owner-diagnostic-${diagnostic.length}` });
    assert.deepEqual(result, { kind: 'transport-failed', resumable: true });
  }

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


test('owner format correction retains exact bytes/schema and session in a read-only view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-report-correction-'));
  const orchestratorHome = join(root, 'orchestrator');
  const targetRoot = join(root, 'target');
  const worktree = join(targetRoot, '.worktrees', 'issue-42');
  await mkdir(worktree, { recursive: true });
  await execFileAsync('git', ['init', worktree]);
  await writeFile(join(worktree, 'feature.txt'), 'checked candidate');
  const workflowGeneration = await materializeWorkflowGeneration({ packageRoot, runtimeRoot: orchestratorHome, packageVersion: '2.0.1', bootId: 'boot-a' });
  const bytes = Buffer.from('{"broken":');
  const reportCorrection = { bytes, sha256: sha256(bytes), diagnostic: 'Unexpected end of JSON input' };
  let calls = 0;
  let transientFailure = false;
  let mutated = false;
  const sessionId = '019a1435-06c0-7860-8f62-b1faadb9662b';
  const process = { run: async (invocation: any) => {
    calls++;
    if (transientFailure) throw Object.assign(new Error('EIO: temporary filesystem error'), { code: 'EIO' });
    assert.notEqual(invocation.cwd, worktree);
    assert.equal(invocation.sessionId, sessionId);
    assert.equal(invocation.operationPolicy.sandboxMode, 'read-only');
    assert.equal(invocation.operationPolicy.runnerPostcondition, 'report-only');
    assert.deepEqual(invocation.operationPolicy.writableRootClasses, []);
    assert.match(invocation.prompt, /Correct only the structured report/u);
    assert.doesNotMatch(invocation.prompt, /Independently prove|Implement issue|When a frozen criterion/u);
    const facts = JSON.parse(await readFile(join(invocation.cwd, `review-facts/correction-${reportCorrection.sha256}.json`), 'utf8'));
    assert.equal(facts.originalReport, bytes.toString());
    assert.equal(facts.originalReportSha256, reportCorrection.sha256);
    assert.equal(facts.diagnostic, reportCorrection.diagnostic);
    assert.ok(facts.schema.properties);
    assert.equal(await readFile(join(invocation.cwd, 'feature.txt'), 'utf8'), 'checked candidate');
    return { kind: 'cancelled' };
  } };
  const issue = { number: 42, title: 'Issue', body: '', url: 'https://example.invalid/42', state: 'OPEN' as const, labels: [] };
  const frozenCriteria = [{ id: 'ac-1', order: 1, source: 'explicit' as const, text: 'Works.' }];
  const signal = new AbortController().signal;
  const implementation = new ContainedImplementationAgent({ config: androidConfigFixture, orchestratorHome,
    parentCodexHome: join(root, 'codex-home'), safePath: '/usr/bin:/bin', bootId: 'boot-a',
    git: { snapshot: async () => runtimeFreshness(mutated ? 'changed' : 'fixture') } as never,
    process: process as never });
  const runImplementation = () => implementation.run({ operation: 'implementation', proofId: 'proof-42', sessionId, attemptId: 'format-implementation', runId: 'run-42', worktreePath: worktree,
    issue, frozenCriteria, deliveryAuthority: { version: 2, kind: 'issue', issueNumber: 42, issueUrl: issue.url, issueSnapshotSha256: '5'.repeat(64), authorizationLabel: 'agent:auto', sourceSha256: '5'.repeat(64), authoritySha256: '6'.repeat(64) },
    cycle: 1, reworkFindings: [], workflowGeneration, reportCorrection, signal });
  assert.deepEqual(await runImplementation(), { kind: 'cancelled' });
  assert.equal(calls, 1);
  transientFailure = true;
  await assert.rejects(runImplementation(), /EIO/u);
  transientFailure = false;
  assert.deepEqual(await runImplementation(), { kind: 'cancelled' });
  const originalRun = process.run;
  process.run = async (invocation: any) => {
    const result = await originalRun(invocation);
    mutated = true;
    return result;
  };
  assert.deepEqual(await runImplementation(), { kind: 'internal-error' });
  assert.equal(await readFile(join(worktree, 'feature.txt'), 'utf8'), 'checked candidate');
});


function runtimeFreshness(worktreeIdentity = 'fixture') {
  return { headSha: '1'.repeat(40), indexTreeSha: '2'.repeat(40), trackedContentSha256: '3'.repeat(64),
    untrackedContentSha256: '4'.repeat(64), worktreeIdentity };
}

function ownerInput(worktreePath: string, workflowGeneration: Parameters<ContainedImplementationAgent['run']>[0]['workflowGeneration']): Parameters<ContainedImplementationAgent['run']>[0] {
  return {
    operation: 'implementation', proofId: 'proof-42', attemptId: 'owner-42', runId: 'run-42', worktreePath,
    issue: { number: 42, title: 'Issue', body: 'Authorized issue.', url: 'https://example.invalid/42', state: 'OPEN', labels: [] },
    frozenCriteria: [{ id: 'ac-1', order: 1, source: 'explicit', text: 'Works.' }],
    deliveryAuthority: { version: 2, kind: 'issue', issueNumber: 42, issueUrl: 'https://example.invalid/42',
      issueSnapshotSha256: '5'.repeat(64), authorizationLabel: 'agent:auto', sourceSha256: '5'.repeat(64), authoritySha256: '6'.repeat(64) },
    cycle: 1, reworkFindings: [], workflowGeneration, signal: new AbortController().signal,
  };
}
