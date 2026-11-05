import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { runConfiguredChecks, runnerCheckAccepted, validateRunnerChecks } from '../src/v2/runner-checks.js';
import { defaultProcessExecutor } from '../src/v2/adapters/command.js';
import { sha256 } from '../src/v2/containment.js';

const exec = promisify(execFile);

for (const scenario of ['matching', 'different', 'affected', 'base-affected', 'skipped', 'uncovered', 'incomplete', 'missing-dependencies', 'local-hook', 'snapshot', 'coverage', 'reporter', 'base-passes', 'dynamic', 'base-dynamic', 'missing-trace', 'skipped-unrelated', 'executor-failed', 'child-signal', 'multiline-mismatch', 'file-read', 'config-drift', 'suite-drift', 'machine-processor', 'large-stderr'] as const) {
  test(`Jest host checks classify ${scenario} failures using the frozen base and passing affected suites`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'jest-host-check-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const worktree = join(root, 'candidate');
    const bin = join(root, 'bin');
    await mkdir(worktree);
    await mkdir(bin);
    const git = (...args: string[]) => exec('git', args, { cwd: worktree });
    await writeFile(join(worktree, 'package.json'), '{"scripts":{"test":"jest"}}');
    await writeFile(join(worktree, 'package-lock.json'), '{}');
    // Project configuration deliberately requires the full configured check.
    await writeFile(join(worktree, 'jest.config.js'), 'module.exports = { projects: ["."] };');
    for (const file of ['feature.js', 'feature.test.js', 'other.test.js']) await writeFile(join(worktree, file), 'base');
    if (scenario === 'file-read') await writeFile(join(worktree, 'other.test.js'), "require('node:fs').readFileSync('feature.js');");
    await git('init', '-b', 'main');
    await git('add', '.');
    await git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base');
    const baseSha = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(join(worktree, 'feature.js'), 'candidate');
    // A normal archive from this repository would drop an assertion suite.
    await writeFile(join(worktree, '.git/info/attributes'), 'other.test.js export-ignore\n');
    const npm = join(bin, 'npm');
    await writeFile(npm, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const candidate = fs.readFileSync('feature.js', 'utf8') === 'candidate';
const scenario = process.env.JEST_FIXTURE_SCENARIO;
if (args[0] === 'ci') process.exit(candidate || scenario === 'missing-dependencies' || !fs.existsSync('other.test.js') ? 9 : 0);
const feature = path.resolve('feature.test.js');
const other = path.resolve('other.test.js');
if (args.includes('--showConfig')) {
  process.stdout.write(JSON.stringify({ configs: [scenario === 'local-hook'
    ? { setupFiles: [path.resolve('support.js')] } : scenario === 'config-drift' && args.includes('--json')
      ? { testMatch: ['changed-in-json-mode'] } : {}], globalConfig: scenario === 'coverage'
      ? { collectCoverage: true, coverageThreshold: { global: { lines: 90 } } }
      : scenario === 'reporter' ? { reporters: [['custom-reporter', {}]] }
      : scenario === 'machine-processor' && args.includes('--json') ? { testResultsProcessor: 'fixture-processor' } : {} }));
  process.exit(0);
}
if (args.includes('--listTests')) {
  process.stdout.write(JSON.stringify(scenario === 'uncovered' ? [] : [scenario === 'affected' || (scenario === 'base-affected' && !candidate) ? other : feature]));
  process.exit(0);
}
if (scenario === 'large-stderr') { fs.writeFileSync(2, Buffer.alloc(17 * 1024 * 1024, 120)); process.exit(0); }
if (scenario === 'base-passes' && !candidate) process.exit(0);
if (scenario === 'reporter' && args.includes('--json')) process.exit(0);
if (!args.includes('--runTestsByPath')) {
  const machine = args.includes('--json');
  const suite = machine && scenario === 'suite-drift' ? 'different.test.js' : 'other.test.js';
  const failure = machine && scenario === 'config-drift' ? 'different assertion' : 'old assertion';
  console.error('FAIL ' + suite + '\\n  ● ' + failure + '\\n\\nPASS feature.test.js\\n\\nTest Suites: 1 failed, 1 passed, 2 total\\nTests:       1 failed, 1 passed, 2 total\\nTime:        0.1 s');
}
const output = args[args.indexOf('--outputFile') + 1];
if (args.includes('--outputFile') && scenario !== 'incomplete') {
  const failure = scenario === 'multiline-mismatch' ? 'Error: request rejected\\n    at server ' + (candidate ? 'A' : 'B')
    : scenario === 'different' && candidate ? 'changed assertion' : 'old assertion';
  const testResult = (name, status, failureMessages) => ({ fullName: name, status, failureMessages });
  const trace = args.includes('--runTestsByPath');
  const testResults = [{ name: other, status: 'failed', assertionResults: [testResult('old test', 'failed', [failure])] }];
  if (!trace) {
    testResults.push({ name: feature, status: scenario === 'skipped' ? 'focused' : 'passed',
      assertionResults: [testResult('feature passes', scenario === 'skipped' ? 'pending' : 'passed', [])] });
    if (scenario === 'skipped-unrelated') testResults.push({ name: path.resolve('skip.test.js'),
      status: 'skipped', assertionResults: [testResult('skipped', 'pending', [])] });
  }
  if (trace && scenario !== 'missing-trace') {
    const urls = [other];
    if ((scenario === 'dynamic' && candidate) || (scenario === 'base-dynamic' && !candidate))
      urls.push(path.resolve('feature.js'));
    fs.writeFileSync(path.join(process.env.NODE_V8_COVERAGE, 'coverage-fixture.json'),
      JSON.stringify({ result: urls.map(url => ({url})) }));
  }
  fs.writeFileSync(output, JSON.stringify({ success: false, wasInterrupted: false, numTotalTestSuites: testResults.length,
    snapshot: { failure: scenario === 'snapshot' && candidate },
    numRuntimeErrorTestSuites: 0, numFailedTestSuites: 1, numFailedTests: 1, testResults }));
  if (scenario === 'child-signal') process.kill(process.pid, 'SIGTERM');
}
process.exit(1);
`);
    await chmod(npm, 0o700);
    const results = await runConfiguredChecks({ checks: { test: 'npm test', later: 'exit 0' }, baseSha,
      worktreePath: worktree, logRoot: join(root, 'logs'), timeoutMs: 5000, signal: new AbortController().signal,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, JEST_FIXTURE_SCENARIO: scenario },
      ...(scenario === 'executor-failed' ? { executor: async (...args: Parameters<typeof defaultProcessExecutor>) => {
        await defaultProcessExecutor(...args);
        throw new Error('The executor lost the result after the process wrote its report.');
      } } : {}),
    });
    const result = results[0]!;
    assert.equal(result.exitCode, scenario === 'large-stderr' ? 0 : scenario === 'child-signal' ? 143 : 1);
    const accepted = scenario === 'matching' || scenario === 'skipped-unrelated' || scenario === 'large-stderr';
    assert.equal(runnerCheckAccepted(result, baseSha), accepted);
    assert.equal(results.length, accepted ? 2 : 1);
    const expectedDiagnostics = {
      matching: undefined, different: { code: 'failure-mismatch', file: 'other.test.js' },
      affected: { code: 'affected-suite', file: 'other.test.js' },
      'base-affected': { code: 'affected-suite', file: 'other.test.js' },
      skipped: { code: 'affected-suite', file: 'feature.test.js' },
      uncovered: { code: 'uncovered-source', file: 'feature.js' },
      incomplete: { code: 'candidate-report' },
      'missing-dependencies': { code: 'base-install' },
      'local-hook': { code: 'configuration-hooks' },
      snapshot: { code: 'snapshot-failure' },
      coverage: { code: 'configuration-coverage' },
      reporter: { code: 'configuration-reporting' },
      'base-passes': { code: 'base-passed' },
      dynamic: { code: 'affected-load', file: 'feature.js' },
      'base-dynamic': { code: 'affected-load', file: 'feature.js' },
      'missing-trace': { code: 'dependency-trace' },
      'skipped-unrelated': undefined,
      'executor-failed': { code: 'candidate-execution' },
      'child-signal': undefined,
      'multiline-mismatch': { code: 'failure-mismatch', file: 'other.test.js' },
      'file-read': { code: 'external-dependency', file: 'other.test.js' },
      'config-drift': { code: 'replay-mismatch' },
      'suite-drift': { code: 'replay-mismatch' },
      'machine-processor': { code: 'configuration-reporting' },
      'large-stderr': undefined,
    };
    assert.deepEqual(result.jestDiagnostic, expectedDiagnostics[scenario]);
    if (result.baseline) {
      assert.deepEqual(result.baseline.affectedTests, ['feature.test.js']);
      assert.equal(runnerCheckAccepted(result, '0'.repeat(40)), false);
    }
    assert.doesNotThrow(() => validateRunnerChecks({ status: 'complete', sourceSha256: sha256('source'),
      policySha256: sha256('policy'), results }));
  });
}
