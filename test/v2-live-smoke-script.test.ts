import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

interface CommandResult { status: number | null; stdout: string; stderr: string }

async function runLiveSmoke(args: string[]): Promise<CommandResult> {
  const scriptPath = await realpath(fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (status) => { resolve({ status, stdout, stderr }); });
  });
}

function listedValues(output: string, label: string): string[] {
  const match = output.match(new RegExp(`^${label}: (.+)$`, 'm'));
  assert.ok(match, `expected ${label} line in output:\n${output}`);
  return match[1].split(',').map((value) => value.trim());
}

async function source(): Promise<string> {
  return readFile(fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url)), 'utf8');
}

const retainedScenarios = [
  'package-install', 'discovery-matrix', 'diagnostics', 'authoritative-candidate-publication',
  'review-feedback-continuation', 'publication-reconciliation', 'review-feedback-negative', 'issue-verification',
];

test('live smoke help pins the V2 scenario and profile matrix', async () => {
  const result = await runLiveSmoke(['--help']);
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(listedValues(result.stdout, 'Scenarios'), retainedScenarios);
  assert.deepEqual(listedValues(result.stdout, 'Profiles'), ['core-release', 'v2-regression', 'full']);
  assert.match(result.stdout, /Default core-release/);
  assert.match(result.stdout, /SergiiMytakii\/codex-orchestrator-live-smoke/u);
  assert.match(result.stdout, /Clean up created issues, PRs, branches, labels, refs, worktrees, processes, and temporary data after the run by default/u);
  assert.match(result.stdout, /Cleanup mode: delete or close\. Default delete/u);
});


test('live smoke omits legacy scenario aliases without distinct V2 behavior', async () => {
  const result = await runLiveSmoke(['--help']);
  for (const alias of [
    'baseline', 'remote-base-branch', 'scoped-runner-commit', 'run-scoped',
    'loop-policy', 'proof-strategy-non-visual-smoke',
    'acceptance-proof-positive',
  ]) {
    assert.doesNotMatch(result.stdout, new RegExp(`\\b${alias}\\b`, 'u'));
  }
});



test('live smoke rejects unknown profile before package or GitHub work', async () => {
  const result = await runLiveSmoke(['--profile', 'missing-profile']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Known profiles: core-release, v2-regression, full/);
  assert.doesNotMatch(result.stdout, /npm pack|scenario/u);
});

test('generated live Codex wrapper preserves native reports and records each invocation', async () => {
  const result = await runLiveSmoke(['--self-test-live-codex']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'V2 live Codex wrapper self-test passed.\n');
});

test('fixture-specific mobile gates are not misrepresented as GitHub live smoke scenarios', async () => {
  const text = await source();
  assert.doesNotMatch(text, /mobile-proof|android-proof|ios-proof/u);
  assert.doesNotMatch(text, /v2-(?:android|ios)-real-gate\.js/u);
});


test('packed smoke parses npm JSON after prepack lifecycle output', async () => {
  const moduleUrl = new URL('../../scripts/live-smoke.mjs', import.meta.url);
  const module = await import(moduleUrl.href) as {
    parseNpmPackOutput: (stdout: string) => Array<{ filename?: unknown }>;
  };
  assert.deepEqual(module.parseNpmPackOutput([
    'cde38bdb71f2b731c7fa050a06dd66f6b639ac879178079a2e4924440d4aed3c',
    '[',
    '  {"filename":"codex-orchestrator-0.1.51.tgz"}',
    ']',
    '',
  ].join('\n')), [{ filename: 'codex-orchestrator-0.1.51.tgz' }]);
});

test('live smoke executes bounded repair-ready continuations and stops at a real result boundary', async () => {
  const module = await import(new URL('../../scripts/live-smoke.mjs', import.meta.url).href) as {
    continueRepairReady: (
      runOnce: () => Promise<{ status: string }>,
      options?: { maxContinuations?: number },
    ) => Promise<{ status: string }>;
  };
  const statuses = ['repair-ready', 'repair-ready', 'review-ready'];
  let calls = 0;
  const settled = await module.continueRepairReady(async () => ({ status: statuses[calls++]! }), { maxContinuations: 3 });
  assert.deepEqual(settled, { status: 'review-ready' });
  assert.equal(calls, 3);

  let boundedCalls = 0;
  await assert.rejects(module.continueRepairReady(async () => {
    boundedCalls += 1;
    return { status: 'repair-ready' };
  }, { maxContinuations: 2 }), /exceeded 2 bounded runs/u);
  assert.equal(boundedCalls, 3);

  let terminalCalls = 0;
  assert.deepEqual(await module.continueRepairReady(async () => {
    terminalCalls += 1;
    return { status: 'blocked' };
  }), { status: 'blocked' });
  assert.equal(terminalCalls, 1);
});

test('live smoke accepts the real repair-ready envelope and resumes bounded infrastructure outcomes', async () => {
  const module = await import(new URL('../../scripts/live-smoke.mjs', import.meta.url).href) as {
    parseRunIssueEnvelope: (stdout: string, exitStatus: number) => { status: string; resumable?: boolean; kind?: string };
    continueRepairReady: (
      runOnce: () => Promise<{ status: string; resumable?: boolean; kind?: string }>,
      options?: { maxContinuations?: number },
    ) => Promise<{ status: string; resumable?: boolean; kind?: string }>;
  };
  const envelope = (result: Record<string, unknown>, exitStatus: number) => module.parseRunIssueEnvelope(JSON.stringify({
    schema: 'codex-orchestrator.agent-auto-run-result', version: 1, result,
  }), exitStatus);
  const results = [
    envelope({ status: 'repair-ready', source: 'review', blockerIds: ['finding-1'], evidencePath: 'repair.json' }, 0),
    envelope({ status: 'transport-failed', resumable: true, evidencePath: 'transport.json' }, 70),
    envelope({ status: 'blocked', kind: 'external', resumable: true, evidencePath: 'service.json' }, 20),
    envelope({ status: 'review-ready', pullRequestUrl: 'https://example.invalid/1', evidencePath: 'ready.json' }, 0),
  ];
  let calls = 0;
  assert.equal((await module.continueRepairReady(async () => results[calls++]!, { maxContinuations: 3 })).status, 'review-ready');
  assert.equal(calls, 4);

  assert.throws(() => envelope({ status: 'repair-ready', source: 'check', blockerIds: [], evidencePath: 'repair.json' }, 70), /exit disagree/u);
  let terminalCalls = 0;
  assert.equal((await module.continueRepairReady(async () => {
    terminalCalls += 1;
    return envelope({ status: 'transport-failed', resumable: false, evidencePath: 'terminal.json' }, 70);
  })).status, 'transport-failed');
  assert.equal(terminalCalls, 1);
});

test('authoritative smoke docs describe only current profiles, labels, and unbounded targeted repair', async () => {
  const [checklist, labels] = await Promise.all([
    readFile(fileURLToPath(new URL('../../docs/live-smoke-checklist.md', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../docs/agents/triage-labels.md', import.meta.url)), 'utf8'),
  ]);
  assert.match(checklist, /two default scenarios/u);
  assert.match(checklist, /targeted repair/u);
  assert.match(checklist, /no semantic round limit/u);
  assert.doesNotMatch(checklist, /spec-first|product-question|fifth failed|all four default|one complete independent review/u);
  assert.match(labels, /agent:auto/u);
  assert.match(labels, /agent:running/u);
  assert.match(labels, /agent:blocked/u);
  assert.match(labels, /agent:review/u);
  assert.doesNotMatch(labels, /agent:waiting-human|ready-for-agent|product-question|spec-first/u);
});




test('live smoke omits the redundant free-form real-codex scenario', async () => {
  const text = await source();
  assert.doesNotMatch(text, /real-codex|runRealCodexScenario/u);
});






test('strict cleanup retries eventually consistent observations before failing', async () => {
  const module = await import(new URL('../../scripts/live-smoke.mjs', import.meta.url).href) as {
    retryCleanupObservation: (action: () => Promise<void>, options: { attempts: number; delayMs: number }) => Promise<void>;
  };
  let attempts = 0;
  await module.retryCleanupObservation(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('not settled');
  }, { attempts: 3, delayMs: 0 });
  assert.equal(attempts, 3);

  await assert.rejects(module.retryCleanupObservation(async () => {
    throw new Error('still present');
  }, { attempts: 2, delayMs: 0 }), /still present/u);
});

test('strict temporary cleanup removes the complete read-only run root', async () => {
  const module = await import(new URL('../../scripts/live-smoke.mjs', import.meta.url).href) as {
    removeTemporaryArtifacts: (context: { root: string; options: { timeoutMs: number } }) => Promise<void>;
  };
  const root = await mkdtemp(join(tmpdir(), 'codex-orchestrator-cleanup-test-'));
  const nested = join(root, 'readonly');
  await mkdir(nested);
  await writeFile(join(nested, 'artifact.json'), '{}\n');
  await chmod(nested, 0o500);
  await module.removeTemporaryArtifacts({ root, options: { timeoutMs: 10_000 } });
  await assert.rejects(readFile(join(nested, 'artifact.json')), /ENOENT/u);
});

// Exercise the actual harness with local Git and fake external command results.
// Unknown external commands fail closed; no offline test can reach GitHub/model services.
type SmokeContext = Record<string, any>;
type SmokeCommand = (command: string, args: string[], options?: Record<string, any>) => Promise<CommandResult>;
const smoke = await import(new URL('../../scripts/live-smoke.mjs', import.meta.url).href) as Record<string, any>;
const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });
const json = (value: unknown): CommandResult => ok(JSON.stringify(value));

async function fixture(t: TestContext): Promise<SmokeContext> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'offline-live-smoke-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetRoot = join(root, 'target');
  await mkdir(join(targetRoot, '.codex-orchestrator'), { recursive: true });
  const git = (args: string[]) => smoke.runCommand('git', ['-C', targetRoot, ...args], { timeoutMs: 30_000 });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'codex-orchestrator']);
  await git(['config', 'user.email', 'codex-orchestrator@users.noreply.github.com']);
  await writeFile(join(targetRoot, '.gitignore'), '.codex-orchestrator/\n');
  await writeFile(join(targetRoot, 'baseline.txt'), 'baseline\n');
  await git(['add', '.']); await git(['commit', '-m', 'baseline']);
  const remote = join(root, 'origin.git');
  await smoke.runCommand('git', ['init', '--bare', remote]);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', 'origin', 'main']);
  const context: SmokeContext = {
    root, targetRoot, git, repo: 'SergiiMytakii/codex-orchestrator-live-smoke', runId: 'offline-test',
    sourceHead: (await git(['rev-parse', 'HEAD'])).stdout.trim(),
    cliPath: fileURLToPath(new URL('../src/v2/cli.js', import.meta.url)),
    liveCodexPath: join(root, 'live-codex'), modelAuditPath: join(root, 'audit.jsonl'),
    orchestratorHome: join(root, 'orchestrator-home'), reportPath: join(root, 'report.md'),
    baseConfig: { runner: {}, proof: {}, codex: {}, github: { baseBranch: 'main' } },
    options: { timeoutMs: 30_000, cleanupMode: 'delete', skipLocalTests: true },
    baselineCandidateRefs: new Set(), baselineWorktrees: new Set([targetRoot]), baselineLabels: new Set(['baseline']),
    createdIssues: [7], createdPullRequests: [], createdBranches: [], createdLabels: [], lockAcquired: true,
  };
  await smoke.configureTarget(context);
  return context;
}

async function writeState(context: SmokeContext, records: unknown[]): Promise<void> {
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator/config.json'), 'utf8'));
  const directory = join(context.targetRoot, config.runner.stateDir, 'v2');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'run-state.json'), JSON.stringify({ schema: 'codex-orchestrator.run-state', runs: records }));
}

async function publishedFixture(context: SmokeContext, scenario: string): Promise<SmokeContext> {
  await context.git(['checkout', '-b', 'codex/issue-7']);
  await mkdir(join(context.targetRoot, 'src/live-smoke'), { recursive: true });
  await writeFile(join(context.targetRoot, `src/live-smoke/${scenario}.txt`), `${scenario}\n`);
  await context.git(['add', '.']); await context.git(['commit', '-m', 'published candidate']);
  await context.git(['push', 'origin', 'codex/issue-7']);
  const head = (await context.git(['rev-parse', 'HEAD'])).stdout.trim();
  const tree = (await context.git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  await context.git(['checkout', 'main']);
  return {
    issueNumber: 7, runId: 'run-7', cycle: 2, checkedChangeSha256: 'checked-1', proofId: 'proof-1',
    proofReceipt: { proofId: 'proof-1' },
    checks: [{ id: 'smoke', command: `${process.execPath} --version`, status: 'passed', bindingId: 'binding-1', candidateTreeSha: tree }],
    codexSession: { id: '019a1435-06c0-7860-8f62-b1faadb9662b' },
    implementationResult: { proof: { status: 'passed' }, review: { reviewers: [
      { role: 'spec_reviewer', sessionId: '019a1435-06c0-7860-8f62-b1faadb9662c', verdict: 'approve' },
      { role: 'standards_reviewer', sessionId: '019a1435-06c0-7860-8f62-b1faadb9662d', verdict: 'approve' },
    ] } },
    terminalOutcome: { status: 'review-ready' }, canonicalRepository: context.repo.toLowerCase(),
    reviewFeedback: { activeBatch: null, previousPublishedHeadSha: head, history: [], consumedSourceIds: [] },
    head,
  };
}

function offlineCommands(context: SmokeContext, result: (args: string[], options: Record<string, any>) => Promise<CommandResult> | CommandResult): SmokeCommand {
  return async (command, args, options = {}) => {
    if (command === 'git' || command === 'chmod') return smoke.runCommand(command, args, options);
    return result([command, ...args], options);
  };
}

async function wrapperFixture(t: TestContext) {
  const context = await fixture(t);
  const wrapper = join(context.root, 'live-codex');
  await writeFile(wrapper, smoke.liveCodexSource(process.execPath, context.modelAuditPath));
  await chmod(wrapper, 0o700);
  // Deliberately return unrelated bytes; an audit wrapper must preserve them exactly.
  const stub = join(context.root, 'codex');
  await writeFile(stub, `#!${process.execPath}\nimport { appendFileSync,writeFileSync } from 'node:fs';\nconst a=process.argv.slice(2);let p='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>{appendFileSync(${JSON.stringify(join(context.root, 'forwarded.jsonl'))},JSON.stringify({args:a,prompt:p})+'\\n');writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({report:{version:1,status:'model-result',targetFingerprint:'wrong-model-target',coverage:['wrong-model-coverage']}}));});\n`);
  await chmod(stub, 0o700);
  const invoke = async (scenario: string, operation: string, extra = '', cwd = context.targetRoot, pin = true, checks = { smoke: `${process.execPath} --version` }) => {
    const reportPath = join(context.root, 'last-report.json');
    const artifacts = join(cwd, '.codex-orchestrator/proof-attempt');
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'transient.txt'), 'discard me');
    await writeFile(join(cwd, '.codex-orchestrator/sentinel.txt'), 'preserve me');
    const prompt = `Implement issue\nLIVE_SMOKE_SCENARIO=${scenario}\nFrozen acceptance criteria: ${JSON.stringify([{ id: 'ac-1', order: 1, source: 'explicit', text: 'fixture criterion' }])}\nRequired configured checks: ${JSON.stringify(checks)}.\nConfigured check receipts: [{"id":"smoke"}]\nWrite evidence only below ${artifacts}.\n${extra}`;
    const result = await smoke.runCommand(wrapper, ['exec', '--output-last-message', reportPath, '-c', 'model_reasoning_effort="high"', ...(pin ? ['-c', 'model="gpt-5.6-luna"'] : [])], {
      cwd, env: { ...process.env, PATH: `${context.root}:${process.env.PATH ?? ''}` }, stdin: prompt, timeoutMs: 30_000, allowedExitCodes: [0, 1, 64],
    });
    let report: any;
    try { report = JSON.parse(await readFile(reportPath, 'utf8')).report; } catch {}
    return { ...result, report, artifacts, reportPath };
  };
  return { context, invoke };
}

test('packed smoke extracts and runs only the public V2 CLI', async (t) => {
  const context = await fixture(t);
  const seen: string[][] = [];
  context.commandRunner = async (command: string, args: string[]) => {
    seen.push([command, ...args]);
    if (command === 'npm') return ok(JSON.stringify([{ filename: 'offline.tgz' }], null, 2) + '\n');
    if (command === 'tar') {
      const cli = join(context.root, 'packed/package/dist/src/v2/cli.js');
      await mkdir(join(cli, '..'), { recursive: true }); await writeFile(cli, '// offline CLI'); return ok();
    }
    assert.deepEqual(args, [join(context.root, 'packed/package/dist/src/v2/cli.js'), '--help']);
    return ok('codex-orchestrator\npublic V2\n');
  };
  assert.equal(await smoke.preparePackagedCandidate(context), join(context.root, 'packed/package/dist/src/v2/cli.js'));
  assert.equal(seen.length, 3);
});

test('preflight rejects repository, auth and dirty source before remote mutation; lock conflicts never confer ownership', async (t) => {
  const context = await fixture(t);
  for (const failure of ['production', 'unapproved', 'gh-auth', 'codex-auth', 'missing-repo', 'dirty', 'none']) {
    const seen: string[][] = [];
    context.repo = failure === 'production' ? 'SergiiMytakii/codex-orchestrator' : failure === 'unapproved' ? 'someone/other' : 'SergiiMytakii/codex-orchestrator-live-smoke';
    context.commandRunner = async (command: string, args: string[]) => {
      seen.push([command, ...args]);
      if ((failure === 'gh-auth' && command === 'gh' && args[0] === 'auth')
        || (failure === 'codex-auth' && command === 'codex')
        || (failure === 'missing-repo' && args[0] === 'repo')) throw new Error(failure);
      return ok(failure === 'dirty' && command === 'git' ? ' M tracked.ts\n' : '');
    };
    if (failure === 'none') await smoke.preflight(context);
    else await assert.rejects(smoke.preflight(context), /restricted|gh-auth|codex-auth|missing-repo|clean immutable HEAD/);
    assert.ok(seen.every((args) => !args.includes('POST') && !args.includes('push') && !args.includes('create')));
    if (failure === 'production' || failure === 'unapproved') assert.deepEqual(seen, []);
    if (failure === 'gh-auth') assert.equal(seen.length, 1);
    if (failure === 'codex-auth') assert.equal(seen.length, 2);
  }
  context.lockAcquired = false; context.createdBranches = [];
  context.commandRunner = async (_command: string, args: string[]) => {
    if (args.includes('defaultBranchRef')) return json({ defaultBranchRef: { name: 'main' } });
    if (args.includes('rev-parse')) return ok(context.sourceHead);
    assert.ok(args.includes('ref=refs/heads/codex-orchestrator-live-smoke-lock'));
    throw new Error('reference already exists');
  };
  await assert.rejects(smoke.acquireScratchLock(context), /reference already exists/);
  assert.equal(context.lockAcquired, false); assert.deepEqual(context.createdBranches, []);
  const fail = context.commandRunner;
  context.commandRunner = async (command: string, args: string[]) => args.includes('POST') ? ok() : fail(command, args);
  await smoke.acquireScratchLock(context);
  assert.equal(context.lockAcquired, true); assert.deepEqual(context.createdBranches, ['codex-orchestrator-live-smoke-lock']);
});

test('cleanup preserves baseline Git refs/worktrees and is a no-op without the scratch lock', async (t) => {
  const context = await fixture(t);
  const baseRef = 'refs/codex-orchestrator/candidates/baseline';
  const runRef = 'refs/codex-orchestrator/candidates/new-run';
  const baseTree = join(context.root, 'baseline-tree'); const runTree = join(context.root, 'run-tree');
  for (const ref of [baseRef, runRef]) await context.git(['update-ref', ref, 'HEAD']);
  await context.git(['worktree', 'add', '--detach', baseTree, 'HEAD']);
  await context.git(['worktree', 'add', '--detach', runTree, 'HEAD']);
  context.baselineCandidateRefs = new Set([baseRef]); context.baselineWorktrees.add(baseTree);
  context.commandRunner = offlineCommands(context, () => { throw new Error('unexpected external command'); });
  const failures: string[] = [];
  context.lockAcquired = false; await smoke.cleanupLocalSafetyResources(context, failures);
  await access(runTree); assert.match((await context.git(['show-ref', runRef])).stdout, /new-run/);
  context.lockAcquired = true; await smoke.cleanupLocalSafetyResources(context, failures);
  assert.deepEqual(failures, []); await access(baseTree);
  assert.match((await context.git(['show-ref', baseRef])).stdout, /baseline/);
  await assert.rejects(access(runTree), /ENOENT/);
  assert.equal((await context.git(['for-each-ref', '--format=%(refname)', runRef])).stdout, '');
});

test('cleanup discovers run artifacts and deletes only those issues, PRs, branches and labels', async (t) => {
  const context = await fixture(t);
  const issues = [{ number: 1, title: 'baseline', body: '' }, { number: 7, title: '[live-smoke:offline-test] issue', body: '' }, { number: 8, title: 'interrupted creation', body: 'LIVE_SMOKE_RUN_ID=offline-test' }];
  let pulls = [{ number: 9, state: 'OPEN', headRefName: 'codex/issue-7' }];
  const labels = new Set(['baseline', 'new-label']); context.createdLabels = ['new-label'];
  const deleted: string[] = [];
  context.commandRunner = offlineCommands(context, (args) => {
    if (args[0] === 'ps') return ok();
    assert.equal(args[0], 'gh');
    if (args[1] === 'issue' && args[2] === 'list') return json(issues);
    if (args[1] === 'pr' && args[2] === 'list') return json(pulls);
    if (args[1] === 'pr' && args[2] === 'close') { deleted.push('pr:' + args[3]); pulls = []; return ok(); }
    if (args[1] === 'issue' && args[2] === 'delete') { deleted.push('issue:' + args[3]); issues.splice(issues.findIndex((issue) => issue.number === Number(args[3])), 1); return ok(); }
    if (args[1] === 'issue' && args[2] === 'view') return { status: 1, stdout: '', stderr: 'not found' };
    if (args.includes('DELETE')) { labels.delete('new-label'); deleted.push('label:new-label'); return ok(); }
    if (args.some((arg) => arg.endsWith('/labels'))) return ok([...labels].join('\n'));
    throw new Error('unexpected external command ' + args.join(' '));
  });
  await smoke.cleanup(context);
  assert.deepEqual(issues.map((issue) => issue.number), [1]);
  assert.deepEqual([...labels], ['baseline']);
  assert.deepEqual(deleted.sort(), ['issue:7', 'issue:8', 'label:new-label', 'pr:9']);
  await assert.rejects(access(context.root), /ENOENT/);
});

test('cleanup terminates an isolated run child and leaves an unrelated child alive', async (t) => {
  const context = await fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)', context.root], { stdio: ['ignore', 'pipe', 'ignore'] });
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const childrenClosed = Promise.all([once(child, 'close'), once(foreign, 'close')]);
  t.after(async () => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      child.kill('SIGKILL'); foreign.kill('SIGKILL');
      await Promise.race([
        childrenClosed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('isolated cleanup children did not close')), 30_000);
        }),
      ]);
    } finally { clearTimeout(timeout); }
  });
  await once(child.stdout!, 'data', { signal: AbortSignal.timeout(30_000) });
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(30_000) });
  const failures: string[] = [];
  await smoke.terminateRunProcesses(context, failures);
  assert.deepEqual(await exited, [null, 'SIGTERM']);
  assert.deepEqual(failures, []); assert.equal(foreign.exitCode, null); assert.equal(foreign.signalCode, null);
});

test('authoritative candidate fixture captures working tree over staged bytes and validates published tree and cleanup', async (t) => {
  const context = await fixture(t);
  const path = 'src/live-smoke/authoritative-candidate-publication.txt';
  await mkdir(join(context.targetRoot, 'src/live-smoke'), { recursive: true });
  await writeFile(join(context.targetRoot, path), 'staged content must not become authoritative\n');
  await context.git(['add', '--', path]);
  await writeFile(join(context.targetRoot, path), 'authoritative-candidate-publication\n');
  assert.equal((await context.git(['show', ':' + path])).stdout, 'staged content must not become authoritative\n');
  assert.equal(await readFile(join(context.targetRoot, path), 'utf8'), 'authoritative-candidate-publication\n');
  await context.git(['add', '-A']); await context.git(['commit', '-m', 'captured working tree']);
  const tree = (await context.git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  const record = { runId: 'run-7', checks: [{ status: 'passed', bindingId: 'b1', candidateTreeSha: tree }] };
  await writeState(context, [record]);
  await smoke.assertAuthoritativeCandidatePublication(context, record, 'HEAD');
  await assert.rejects(smoke.assertAuthoritativeCandidatePublication(context, { ...record, checks: [{ ...record.checks[0], candidateTreeSha: 'wrong' }] }, 'HEAD'), /candidateTreeSha !== publishedTreeSha/);
  const pin = 'refs/codex-orchestrator/candidates/run-7/b1';
  await context.git(['update-ref', pin, 'HEAD']);
  await assert.rejects(smoke.assertAuthoritativeCandidatePublication(context, record, 'HEAD'), /candidate pin survived/);
  await context.git(['update-ref', '-d', pin]);
  const execution = join(context.targetRoot, '.codex-orchestrator/workspaces-v2-offline-test/.candidate-executions/run-7/b1');
  await mkdir(execution, { recursive: true }); await writeFile(join(execution, 'leftover'), 'unsafe');
  await assert.rejects(smoke.assertAuthoritativeCandidatePublication(context, record, 'HEAD'), /execution directory survived/);
  await rm(execution, { recursive: true });
  await assert.rejects(smoke.assertAuthoritativeCandidatePublication(context, { ...record, candidateBinding: { id: 'b1' } }, 'HEAD'), /durable candidate ownership/);
});

test('audit wrapper preserves native report bytes, prompt, session argv, and product files', async (t) => {
  const { context, invoke } = await wrapperFixture(t);
  const before = (await context.git(['status', '--porcelain=v1', '-z'])).stdout;
  const result = await invoke('authoritative-candidate-publication', 'implementation');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(result.reportPath, 'utf8'), JSON.stringify({ report: {
    version: 1, status: 'model-result', targetFingerprint: 'wrong-model-target', coverage: ['wrong-model-coverage'],
  } }));
  assert.equal((await context.git(['status', '--porcelain=v1', '-z'])).stdout, before);
  assert.equal(await readFile(join(result.artifacts, 'transient.txt'), 'utf8'), 'discard me');
  const forwarded = JSON.parse((await readFile(join(context.root, 'forwarded.jsonl'), 'utf8')).trim());
  assert.match(forwarded.prompt, /LIVE_SMOKE_SCENARIO=authoritative-candidate-publication/u);
  assert.ok(forwarded.args.includes('model_reasoning_effort="high"'));
});

test('audit wrapper forwards native resume identity and leaves malformed reports untouched', async (t) => {
  const { context } = await wrapperFixture(t);
  const raw = '{malformed model report';
  const stub = join(context.root, 'codex');
  await writeFile(stub, `#!${process.execPath}\nimport {writeFileSync,appendFileSync} from 'node:fs';
    const a=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{
      appendFileSync(${JSON.stringify(join(context.root, 'resume-argv.json'))},JSON.stringify(a));
      writeFileSync(a[a.indexOf('--output-last-message')+1],${JSON.stringify(raw)});
      process.stdout.write('native-jsonl-output');
    });`);
  const id = '019a1435-06c0-7860-8f62-b1faadb9662b';
  const reportPath = join(context.root, 'resume-report.json');
  const args = ['exec', '--json', '--sandbox', 'read-only', '--output-last-message', reportPath,
    '-c', 'model="gpt-5.6-luna"', 'resume', id, '-'];
  const result = await smoke.runCommand(join(context.root, 'live-codex'), args, {
    cwd: context.targetRoot, env: { ...process.env, PATH: `${context.root}:${process.env.PATH ?? ''}` }, stdin: 'unchanged prompt',
  });
  assert.equal(result.stdout, 'native-jsonl-output');
  assert.equal(await readFile(reportPath, 'utf8'), raw);
  assert.deepEqual(JSON.parse(await readFile(join(context.root, 'resume-argv.json'), 'utf8')), args);
});

test('audit wrapper records and returns a failed native call once without retrying it', async (t) => {
  const { context, invoke } = await wrapperFixture(t);
  await writeFile(join(context.root, 'codex'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{
    process.stderr.write('stream disconnected before completion');process.exitCode=1;
  });`);
  const result = await invoke('package-install', 'implementation', 'Independently prove issue');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stream disconnected before completion/u);
  const audit = (await readFile(context.modelAuditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].exitCode, 1);
});

test('model pin, reasoning effort, isolated home and workflow budgets reach the executable boundary', async (t) => {
  const { context, invoke } = await wrapperFixture(t);
  assert.equal(smoke.parseArgs([]).timeoutMs, 1_800_000);
  const config = JSON.parse(await readFile(join(context.targetRoot, '.codex-orchestrator/config.json'), 'utf8'));
  assert.equal(config.codex.command, context.liveCodexPath); assert.equal(config.codex.timeoutMs, 600_000);
  const env = smoke.liveSmokeEnv(context);
  assert.equal(env.CODEX_ORCHESTRATOR_HOME, join(context.root, 'orchestrator-home'));
  assert.equal(env.CODEX_ORCHESTRATOR_LIVE_SMOKE_MODEL, 'gpt-5.6-luna');
  const denied = await invoke('package-install', 'implementation', '', context.targetRoot, false);
  assert.equal(denied.status, 64); await assert.rejects(access(join(context.root, 'forwarded.jsonl')), /ENOENT/);
  assert.equal((await invoke('package-install', 'implementation')).status, 0);
  const forwarded = JSON.parse((await readFile(join(context.root, 'forwarded.jsonl'), 'utf8')).trim());
  assert.ok(forwarded.args.includes('model="gpt-5.6-luna"')); assert.ok(forwarded.args.includes('model_reasoning_effort="high"'));
  smoke.assertScenarioModelUsage('package-install', [{ model: 'gpt-5.6-luna' }]);
  assert.throws(() => smoke.assertScenarioModelUsage('package-install', []), /no real Codex/);
  assert.throws(() => smoke.assertScenarioModelUsage('package-install', [{ model: 'other' }]), /model audit/);
});

test('daemon selects the requested authoritative outcome and guards ownership before and after execution', async (t) => {
  const context = await fixture(t);
  await writeState(context, [{ issueNumber: 8, terminalOutcome: { status: 'blocked', kind: 'external' } }, { issueNumber: 7, terminalOutcome: { status: 'review-ready', continuationEpoch: 'wanted-head' } }]);
  let launches = 0; let phase = 0;
  let candidates: number[] = [7]; let postCandidates: number[] = [7];
  context.commandRunner = async (command: string, args: string[], options: Record<string, any>) => {
    if (command === 'gh') return json((phase ? postCandidates : candidates).map((number) => ({ number })));
    launches += 1; phase = 1;
    assert.deepEqual(args, [context.cliPath, 'daemon', '--target', context.targetRoot, '--once', '--issue', '7']);
    assert.equal(options.env.CODEX_ORCHESTRATOR_HOME, context.orchestratorHome);
    assert.equal(options.timeoutMs, context.options.timeoutMs);
    return ok('{"result":{"status":"blocked","kind":"safety"}}');
  };
  assert.deepEqual(await smoke.runDaemonOnce(context, 7), { status: 'review-ready', continuationEpoch: 'wanted-head' });
  assert.equal(launches, 1);
  for (const invalid of [[8], [7, 99], []]) {
    candidates = invalid; phase = 0; launches = 0;
    await assert.rejects(smoke.runDaemonOnce(context, 7), /exclusive scratch ownership/); assert.equal(launches, 0);
  }
  candidates = [7]; postCandidates = [7, 99]; phase = 0;
  await assert.rejects(smoke.runDaemonOnce(context, 7), /exclusive scratch ownership/); assert.equal(launches, 1);
  postCandidates = [7]; phase = 0; await writeState(context, [{ issueNumber: 8 }]);
  await assert.rejects(smoke.runDaemonOnce(context, 7), /issue #7 is missing/);
  await writeState(context, [{ issueNumber: 7 }]); phase = 0;
  await assert.rejects(smoke.runDaemonOnce(context, 7), /terminal outcome for issue #7/);
});

async function scenarioFixture(t: TestContext, scenario: string, fault = '') {
  const context = await fixture(t);
  const record = await publishedFixture(context, scenario);
  const initialRecord = structuredClone(record);
  let runs = 0; let daemons = 0; let resolved = false;
  const commands: string[][] = [];
  let comments: { body: string }[] = [];
  const envelope = (result: any) => json({ schema: 'codex-orchestrator.agent-auto-run-result', version: 1, result });
  const runner: SmokeCommand = async (command, args, options = {}) => {
    commands.push([command, ...args]);
    if (command === 'git' || command === 'chmod') return smoke.runCommand(command, args, options);
    if (command === 'which') return ok(join(context.root, 'offline-gh'));
    if (command === 'npm') {
      const cli = join(options.cwd, 'node_modules/codex-orchestrator/dist/src/v2/cli.js');
      await mkdir(join(cli, '..'), { recursive: true }); await writeFile(cli, '// installed packed CLI'); return ok();
    }
    if (command === process.execPath) {
      assert.equal(options.timeoutMs, context.options.timeoutMs);
      if (['doctor', 'status'].includes(args[1])) {
        if (fault === 'diagnostics-effect') await writeFile(join(context.targetRoot, 'unexpected-write'), 'effect');
        return json({ schema: 'codex-orchestrator.agent-auto-setup-result', version: 1, result: { status: 'inspected' } });
      }
      if (args[1] === 'daemon') {
        daemons += 1;
        if (scenario === 'review-feedback-continuation' && daemons === 1) {
          await context.git(['checkout', 'codex/issue-7']);
          await writeFile(join(context.targetRoot, `src/live-smoke/${scenario}-addressed.txt`), 'addressed review feedback\n');
          await context.git(['add', '.']); await context.git(['commit', '-m', 'address review']); await context.git(['push', 'origin', 'codex/issue-7']);
          const head = (await context.git(['rev-parse', 'HEAD'])).stdout.trim(); await context.git(['checkout', 'main']);
          record.checkedChangeSha256 = fault === 'stale-proof' ? initialRecord.checkedChangeSha256 : 'checked-2';
          record.proofId = 'proof-2';
          if (fault === 'different-owner') record.codexSession.id = '019a1435-06c0-7860-8f62-b1faadb9662e';
          record.reviewFeedback.history = [{ kind: 'published', batchId: 'batch-1', publishedHeadSha: head }];
          record.terminalOutcome = { status: 'review-ready', continuationEpoch: head };
          comments = [{ body: '<!-- codex-orchestrator:run:run-7:review-feedback:batch-1 -->\nRepaired.' }];
          await writeState(context, [record]);
        }
        if (fault === 'resolved-feedback-effect' && scenario === 'review-feedback-negative') { record.cycle += 1; await writeState(context, [record]); }
        if (fault === 'replay-effect' && daemons === 2) { record.cycle += 1; await writeState(context, [record]); }
        return ok('daemon stdout is not an outcome');
      }
      assert.equal(args[1], 'run'); runs += 1;
      assert.equal(options.env.CODEX_ORCHESTRATOR_HOME, context.orchestratorHome);
      if (scenario === 'publication-reconciliation' && runs === 1) return { ...envelope({ status: 'transport-failed', resumable: true }), status: 70 };
      if (fault === 'bad-check') record.checks[0].command = 'untrusted issue command';
      if (fault === 'bad-cycle') record.cycle = 1;
      if (scenario === 'publication-reconciliation' && fault === 'repeated-model') await writeFile(context.modelAuditPath, JSON.stringify({ operation: 'implementation' }) + '\n');
      await writeState(context, [record]);
      return envelope({ status: 'review-ready' });
    }
    assert.equal(command, 'gh', 'offline fixture refuses every unknown external command');
    if (args[0] === 'issue' && args[1] === 'create') return ok(`https://github.invalid/${context.repo}/issues/7\n`);
    if (args[0] === 'issue' && args[1] === 'list') return json([{ number: 7 }]);
    if (args[0] === 'issue' && args[1] === 'view') return json({ labels: [{ name: 'agent:review' }] });
    if (args[0] === 'pr' && args[1] === 'list') {
      if (fault === 'changed-pr' && daemons > 0) return json([{ number: 12, isDraft: true }]);
      return json(fault === 'second-pr' ? [{ number: 11, isDraft: true }, { number: 12, isDraft: true }] : [{ number: 11, isDraft: true }]);
    }
    if (args.includes('POST')) { const body = args.find((arg) => arg.startsWith('body='))!.slice(5); return json({ id: 91, body }); }
    if (args.some((arg) => arg.includes('resolveReviewThread(input:'))) { resolved = true; return json({ data: {} }); }
    const query = args.find((arg) => arg.startsWith('query='));
    if (query?.includes('comments(first:100){nodes{databaseId}}')) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'thread-1', comments: { nodes: [{ databaseId: 91 }] } }] } } } } });
    if (query?.includes('query ReviewThreads')) return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'thread-1', isResolved: false, isOutdated: false, path: `src/live-smoke/${scenario}.txt`, line: 1, comments: { nodes: [{ id: 'comment-node', databaseId: 91, url: 'https://github.invalid/comments/91', body: 'Repair this.', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', originalCommit: { oid: record.head }, commit: { oid: record.head }, author: { __typename: 'User', id: 'user-node', databaseId: 1, login: 'owner' } }], pageInfo: { hasNextPage: false, endCursor: null } } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    if (query) return json({ data: { repository: { id: 'repo-node', name: 'codex-orchestrator-live-smoke', owner: { id: 'owner-node', login: 'SergiiMytakii' }, pullRequest: { id: 'pr-node', number: 11, url: 'https://github.invalid/pull/11', state: 'OPEN', isDraft: true, isCrossRepository: false, headRefName: 'codex/issue-7', headRefOid: record.head, baseRefName: 'main', title: 'offline', body: '<!-- codex-orchestrator:run:run-7:pr -->', authorAssociation: 'OWNER' } } } });
    if (args.some((arg) => arg.endsWith('/permission'))) return json({ permission: 'write', user: { id: '1' } });
    if (args.some((arg) => arg.endsWith('/reviews'))) return ok('');
    if (args.some((arg) => arg.endsWith('/labels'))) return ok('baseline');
    if (args.some((arg) => arg.endsWith('/issues/7/comments'))) return json([{ body: '<!-- codex-orchestrator:run:run-7:cycle:2:handoff -->\nReady.' }]);
    if (args.some((arg) => arg.endsWith('/issues/11/comments'))) return json(comments);
    throw new Error('unhandled offline command ' + [command, ...args].join(' '));
  };
  context.commandRunner = runner;
  if (fault === 'retained-pin') {
    await context.git(['update-ref', `refs/codex-orchestrator/candidates/${record.runId}/${record.checks[0].bindingId}`, record.head]);
  }
  if (fault === 'retained-worktree') {
    await context.git(['worktree', 'add', '--detach', join(context.root, '.candidate-executions/leaked'), record.head]);
  }
  await writeState(context, [record]);
  return { context, commands, record, counts: () => ({ runs, daemons, resolved }) };
}

for (const [scenario, entry] of [
  ['authoritative-candidate-publication', 'runReviewReadyScenario'],
  ['publication-reconciliation', 'runPublicationReconciliationScenario'],
  ['review-feedback-negative', 'runReviewFeedbackNegativeScenario'], ['issue-verification', 'runIssueVerificationScenario'],
  ['package-install', 'runPackageInstallScenario'],
]) {
  test(`offline ${scenario} executes its actual scenario assertions against local published Git`, async (t) => {
    const { context, commands, counts } = await scenarioFixture(t, scenario);
    const originalCli = context.cliPath;
    await smoke[entry](context, scenario);
    assert.equal(context.cliPath, originalCli);
    if (scenario === 'review-feedback-negative') { assert.equal(counts().resolved, true); assert.equal(counts().daemons, 1); }
    if (scenario === 'package-install') {
      const run = commands.find((args) => args[0] === process.execPath && args[2] === 'run')!;
      assert.match(run[1], /consumer\/node_modules\/codex-orchestrator\/dist\/src\/v2\/cli.js$/);
    }
    assert.ok(counts().runs >= 1);
  });
}

for (const [scenario, entry, fault, diagnostic] of [
  ['authoritative-candidate-publication', 'runReviewReadyScenario', 'retained-pin', /candidate pin survived successful publication/],
  ['authoritative-candidate-publication', 'runReviewReadyScenario', 'retained-worktree', /candidate execution worktree survived successful publication/],
  ['publication-reconciliation', 'runPublicationReconciliationScenario', 'repeated-model', /repeated model work/],
  ['issue-verification', 'runIssueVerificationScenario', 'bad-check', /Issue text replaced/],
  ['review-feedback-negative', 'runReviewFeedbackNegativeScenario', 'resolved-feedback-effect', /resolved feedback produced work or durable state/],
] as const) {
  test(`offline ${scenario} catches ${fault} at its intended assertion`, async (t) => {
    const { context } = await scenarioFixture(t, scenario, fault);
    await assert.rejects(smoke[entry](context, scenario), diagnostic);
  });
}

test('diagnostics executes installed CLI with unchanged local, remote and model state', async (t) => {
  for (const fault of ['', 'diagnostics-effect']) {
    const { context, commands } = await scenarioFixture(t, 'diagnostics', fault);
    if (fault) await assert.rejects(smoke.runDiagnosticsScenario(context, 'diagnostics'), /read-only diagnostics mutated/);
    else await smoke.runDiagnosticsScenario(context, 'diagnostics');
    const inspected = commands.filter((args) => args[0] === process.execPath && ['doctor', 'status'].includes(args[2]));
    assert.deepEqual(inspected.map((args) => args[2]), ['doctor', 'status']);
    assert.ok(inspected.every((args) => args[1].includes('/diagnostics-consumer/node_modules/codex-orchestrator/')));
    assert.ok(commands.every((args) => !args.includes('create') && !args.includes('run')));
    await assert.rejects(access(context.modelAuditPath), /ENOENT/);
    smoke.assertScenarioModelUsage('diagnostics', []);
    assert.throws(() => smoke.assertScenarioModelUsage('diagnostics', [{ model: 'gpt-5.6-luna' }]), /model-free gate/);
  }
});

test('review feedback continuation publishes one same-PR commit, refreshes proof and replays without effects', async (t) => {
  const { context, counts, record } = await scenarioFixture(t, 'review-feedback-continuation');
  const initialProof = record.proofId;
  await smoke.runReviewFeedbackContinuationScenario(context, 'review-feedback-continuation');
  assert.equal(counts().daemons, 2); assert.equal(record.proofId, 'proof-2'); assert.notEqual(record.proofId, initialProof);
  assert.deepEqual(context.createdPullRequests, [11]);
  assert.equal(record.reviewFeedback.history.length, 1);
  const head = record.reviewFeedback.history[0].publishedHeadSha;
  assert.equal((await context.git(['show', `${head}:src/live-smoke/review-feedback-continuation-addressed.txt`])).stdout, 'addressed review feedback\n');
});

for (const [fault, diagnostic] of [['different-owner', /issue session changed/], ['stale-proof', /checks and proof were not refreshed/], ['changed-pr', /preserve the one existing PR/], ['replay-effect', /replay produced a persisted or remote effect/]] as const) {
  test(`review feedback continuation catches ${fault}`, async (t) => {
    const { context } = await scenarioFixture(t, 'review-feedback-continuation', fault);
    await assert.rejects(smoke.runReviewFeedbackContinuationScenario(context, 'review-feedback-continuation'), diagnostic);
  });
}

test('scratch label setup must complete before labels or config are adopted', async (t) => {
  const context = await fixture(t);
  for (const status of ['blocked', 'configured', 'labels-prepared']) {
    let reads = 0;
    context.commandRunner = async (command: string, args: string[]) => {
      if (command === process.execPath) {
        assert.ok(args.includes('--prepare-labels'));
        return json({ schema: 'codex-orchestrator.agent-auto-setup-result', version: 1, result: { status } });
      }
      reads += 1;
      return ok('baseline\nnew-label\n');
    };
    if (status === 'labels-prepared') {
      await smoke.prepareLabels(context);
      assert.deepEqual(context.createdLabels, ['new-label']); assert.equal(reads, 1);
    } else {
      await assert.rejects(smoke.prepareLabels(context), new RegExp('setup was incomplete: ' + status));
      assert.equal(reads, 0);
    }
  }
});
