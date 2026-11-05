import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { CommandProcessQuiescenceError } from './adapters/command.js';
import { canonicalJson, sha256 } from './containment.js';
import { jestCommand } from './jest-command.js';
import type { RunnerCheckResult, TestBaselineEvidence } from './runner-checks.js';

export type JestBaselineEvidence = TestBaselineEvidence & { kind: 'jest' };

const diagnostics = {
  'candidate-execution': ['The configured Jest command did not complete normally.', 'Inspect the original check log for process, resource, or output errors before retrying.'],
  'candidate-report': ['Jest did not produce a complete assertion failure report.', 'Inspect the original check log for a failed suite, setup error, or unsupported Jest invocation.'],
  'unsupported-scope': ['The change includes paths whose Jest impact cannot be established.', 'Run the full check successfully or configure a check that covers these changes.'],
  'uncovered-source': ['Jest found no related tests for a changed file.', 'Add coverage or configure a Jest project that includes the changed file.'],
  'affected-suite': ['A related Jest suite failed, was skipped, or did not run.', 'Run and fix the affected tests before retrying.'],
  'base-preparation': ['The Runner could not materialize the exact base tree.', 'Inspect the archive logs and run the full check if the base uses unsupported Git attributes, links, or submodules.'],
  'base-lockfile': ['The base commit has no npm lockfile.', 'Provide a committed npm lockfile or run the full check successfully.'],
  'base-command': ['The configured Jest invocation could not be reproduced on the base commit.', 'Use a comparable locked Jest invocation or run the full candidate check successfully.'],
  'base-install': ['Installing the locked dependencies on the base commit failed.', 'Inspect the retained npm install log and make missing locked dependencies available in the local cache.'],
  'snapshot-failure': ['Jest reported a snapshot failure in addition to any assertion failures.', 'Inspect the snapshot diff and resolve it before retrying.'],
  'dependency-trace': ['The Runner could not verify the modules loaded by the failing Jest suites.', 'Inspect the retained Jest trace check logs and run the full check successfully.'],
  'external-dependency': ['A failing Jest suite uses local filesystem or subprocess APIs outside the module graph.', 'Run the full check successfully or isolate the failing suite from those dependencies.'],
  'affected-load': ['A failing Jest suite loaded a changed file at runtime.', 'Fix the affected suite before retrying.'],
  'comparison-timeout': ['The Jest baseline comparison exceeded the host check time budget.', 'Inspect the retained logs and increase the configured timeout if the checks need more time.'],
  'configuration-output': ['The Runner could not read Jest’s resolved configuration.', 'Inspect the configured Jest command and run the full check successfully.'],
  'configuration-selection': ['Jest uses a selection or early-exit setting that prevents a complete comparison.', 'Run a complete Jest check without filtering or early exit.'],
  'configuration-coverage': ['The configured Jest check collects coverage, which can fail independently of assertions.', 'Run the full coverage check successfully before retrying.'],
  'configuration-reporting': ['A custom Jest reporter or results processor can change the check outcome.', 'Run the configured check successfully with its custom reporting enabled.'],
  'configuration-hooks': ['A local Jest hook can load files outside the dependency graph.', 'Run the full check successfully or isolate the hook dependencies.'],
  'replay-mismatch': ['The machine-readable Jest replay did not reproduce the original failure output.', 'Compare the two runs in the retained check log and fix the original failure or any nondeterminism before retrying.'],
  'related-selection': ['Jest could not reliably enumerate the affected suites.', 'Inspect the retained test selection logs and correct the Jest project configuration.'],
  'base-passed': ['The full Jest check passed on the base commit but failed on the candidate.', 'Inspect the candidate failure and fix the regression before retrying.'],
  'base-report': ['Jest on the base commit did not produce a comparable assertion failure report.', 'Inspect the base check log and resolve the differing test or environment failure.'],
  'failure-mismatch': ['The failing Jest assertions or their error messages differ from the base commit.', 'Investigate the candidate failure and fix the regression before retrying.'],
} as const;

export interface JestDiagnostic {
  code: keyof typeof diagnostics;
  file?: string;
}

export function jestDiagnosticText(diagnostic: JestDiagnostic): readonly [string, string] {
  return diagnostics[diagnostic.code];
}

export function jestEvidencePath(file: unknown): file is string {
  return typeof file === 'string' && file.length > 0 && file.length <= 500
    && !isAbsolute(file) && !file.startsWith('-') && !file.includes('\\') && !file.includes(' :: ')
    && posix.normalize(file) === file && !file.split('/').some(part => part === '.' || part === '..')
    && !/[\u0000-\u001f\u007f]/u.test(file);
}

export function validJestDiagnostic(value: unknown): value is JestDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return typeof d.code === 'string' && Object.hasOwn(diagnostics, d.code)
    && Object.keys(d).every(key => key === 'code' || key === 'file')
    && (!Object.hasOwn(d, 'file') || jestEvidencePath(d.file));
}

type LoggedCommand = (command: string, cwd: string, label: string) => Promise<RunnerCheckResult>;
const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
const shell = (args: string[]) => args.map(quote).join(' ');

/** Compare complete Jest reports and require passing coverage from both dependency graphs. */
export async function confirmJestBaseline(input: {
  command: string; reportPath: string; baseSha: string; worktreePath: string; logRoot: string; run: LoggedCommand;
}): Promise<{ baseline: JestBaselineEvidence } | { jestDiagnostic: JestDiagnostic }> {
  const decline = (code: JestDiagnostic['code'], file?: string) => ({
    jestDiagnostic: { code, ...(jestEvidencePath(file) ? { file } : {}) },
  });
  const base = join(input.logRoot, 'base');
  const archive = join(input.logRoot, 'base.tar');
  const gitDirectory = join(input.logRoot, 'archive.git');
  const coverage = join(input.logRoot, 'v8-coverage');
  let cleanup = true;
  let stage: JestDiagnostic['code'] = 'candidate-report';
  try {
    const candidate = await readComparableReport(input.reportPath, input.worktreePath);
    if ('code' in candidate) return decline(candidate.code);
    const command = jestCommand(input.worktreePath, input.command);
    if (!command) return decline(stage);
    const invoke = async (args: string[], cwd: string, label: string) => {
      const result = await input.run(shell(args), cwd, label);
      if (result.exitCode !== 0) throw new Error('Jest evidence command failed.');
      return result;
    };
    const gitPaths = async (args: string[], label: string) =>
      (await readFile((await invoke(['env', 'GIT_NO_REPLACE_OBJECTS=1', 'git', ...args], input.worktreePath, label)).logPath, 'utf8')).split('\0').filter(Boolean);
    stage = 'unsupported-scope';
    const tracked = await gitPaths(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', input.baseSha, '--'], 'jest-changed');
    const untracked = await gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], 'jest-untracked');
    const changed = [...new Set([...tracked, ...untracked])].sort();
    // Per-file queries prove coverage. Limit extra processes on large changes.
    if (!changed.length || changed.length > 32) return decline(stage);
    for (const file of changed) {
      if (!jestEvidencePath(file) || !/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file)
        || /(?:^|\/)(?:__mocks__|__snapshots__)(?:\/|$)|(?:config|setup)/iu.test(file)
        || !(await regularFile(input.worktreePath, file))) return decline(stage, file);
    }

    const related = async (root: string, files: string[], label: string): Promise<string[]> => {
      const result = await invoke(['npm', '--silent', ...command.npmArgs, '--', ...command.extra,
        '--listTests', '--json', '--findRelatedTests', ...files.map(file => './' + file)], root, label);
      const log = await readFile(result.logPath, 'utf8');
      const arrays = log.split('\n').map(line => line.trim()).filter(line => line.startsWith('[') && line.endsWith(']'));
      if (arrays.length !== 1) throw new Error('Invalid Jest list output.');
      const paths: unknown = JSON.parse(arrays[0]!);
      if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !isAbsolute(path)))
        throw new Error('Invalid Jest suite paths.');
      const rootPath = await realpath(root);
      const names = paths.map(path => relative(rootPath, path));
      if (!names.every(jestEvidencePath)) throw new Error('A Jest suite is outside the checkout.');
      return names;
    };
    const affected = new Set<string>();
    stage = 'related-selection';
    for (const file of changed) {
      const suites = await related(input.worktreePath, [file], 'jest-candidate-related');
      if (!suites.length) return decline('uncovered-source', file);
      if ((candidate.seen.has(file) || /(?:^|\/)__tests__\/|\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file))
        && !candidate.passing.has(file)) return decline('affected-suite', file);
      for (const suite of suites) {
        if (!candidate.passing.has(suite)) return decline('affected-suite', suite);
        affected.add(suite);
      }
    }

    stage = 'base-preparation';
    const tree = await gitPaths(['ls-tree', '-r', '-z', input.baseSha], 'jest-base-files');
    const baseFiles = new Set<string>();
    for (const entry of tree) {
      const match = /^100(?:644|755) blob [a-f0-9]{40}\t([^\0]+)$/u.exec(entry);
      if (!match || /(?:^|\/)\.gitattributes$/u.test(match[1]!)) return decline(stage);
      baseFiles.add(match[1]!);
    }
    const objects = (await readFile((await invoke(['git', 'rev-parse', '--path-format=absolute', '--git-path', 'objects'],
      input.worktreePath, 'jest-git-objects')).logPath, 'utf8')).trimEnd();
    if (!isAbsolute(objects) || /[\r\n]/u.test(objects)) return decline(stage);
    await mkdir(base, { mode: 0o700 });
    // Archive from private Git metadata so repository-local info/attributes
    // cannot rewrite or omit objects from the frozen commit.
    await invoke(['git', 'init', '--bare', '--template=', gitDirectory], base, 'jest-archive-init');
    await invoke(['env', 'GIT_ATTR_NOSYSTEM=1', 'GIT_NO_REPLACE_OBJECTS=1', 'GIT_CONFIG_NOSYSTEM=1',
      'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_OBJECT_DIRECTORY=' + objects,
      'git', '--git-dir=' + gitDirectory, '-c', 'core.attributesFile=/dev/null',
      'archive', '--format=tar', '--output=' + archive, input.baseSha], base, 'jest-archive');
    await invoke(['tar', '-xf', archive, '-C', base], input.worktreePath, 'jest-extract');
    await rm(archive);
    if (!baseFiles.has('package-lock.json') && !baseFiles.has('npm-shrinkwrap.json')) return decline('base-lockfile');
    stage = 'base-command';
    const baseCommand = jestCommand(base, input.command);
    if (!baseCommand || canonicalJson(baseCommand.flags) !== canonicalJson(command.flags)) return decline(stage);
    stage = 'base-install';
    await invoke(['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], base, 'jest-base-install');

    stage = 'related-selection';
    const baseChanged = changed.filter(file => baseFiles.has(file));
    if (baseChanged.length) {
      for (const suite of await related(base, baseChanged, 'jest-base-related')) {
        if (!candidate.passing.has(suite)) return decline('affected-suite', suite);
        affected.add(suite);
      }
    }

    stage = 'base-report';
    const baseReportPath = join(input.logRoot, 'base-jest.json');
    const result = await input.run(shell([process.execPath, fileURLToPath(new URL('./candidate-check.js', import.meta.url)),
      'HEAD', input.command, baseReportPath]), base, 'jest-base-test');
    if (result.exitCode === 0) return decline('base-passed');
    if (result.exitCode !== 1) return decline(stage);
    const original = await readComparableReport(baseReportPath, base);
    if ('code' in original) return decline(original.code === 'candidate-report' ? 'base-report' : original.code);
    for (const [test, failure] of candidate.failures) {
      if (original.failures.get(test)?.errorSha256 !== failure.errorSha256) return decline('failure-mismatch', failure.file);
    }
    if (candidate.failures.size !== original.failures.size) return decline('failure-mismatch');

    // Jest's static graph cannot see computed imports. Re-run only the failing suites
    // on both trees and require V8 to confirm that none loaded a changed file.
    stage = 'dependency-trace';
    const failedSuites = [...new Set([...candidate.failures.values()].map(failure => failure.file))].sort();
    for (const [checkout, label] of [[input.worktreePath, 'candidate'], [base, 'base']] as const) {
      const trace = join(coverage, label);
      await mkdir(trace, { recursive: true, mode: 0o700 });
      const traceReport = join(input.logRoot, label + '-trace-jest.json');
      const traceResult = await input.run(shell(['env', 'NODE_V8_COVERAGE=' + trace, 'npm', ...command.npmArgs,
        '--', ...command.extra, '--json', '--outputFile', traceReport,
        '--runTestsByPath', ...failedSuites.map(file => './' + file)]), checkout, 'jest-' + label + '-trace');
      if (traceResult.exitCode !== 1) return decline(stage);
      const report = await readJestReport(traceReport, checkout);
      if (!report || 'snapshotFailure' in report || report.seen.size !== failedSuites.length
        || report.failures.size !== candidate.failures.size || [...candidate.failures].some(
          ([test, failure]) => report.failures.get(test)?.errorSha256 !== failure.errorSha256)) return decline(stage);
      const loaded = await readLoadedFiles(trace, checkout);
      if (!failedSuites.every(file => loaded.has(file))) return decline(stage);
      const changedLoad = changed.find(file => loaded.has(file));
      if (changedLoad) return decline('affected-load', changedLoad);
      for (const file of loaded) {
        if (!/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file) || file.split('/').includes('node_modules')) continue;
        const path = join(checkout, file);
        if (!await regularFile(checkout, file) || (await lstat(path)).size > 2 * 1024 * 1024) return decline(stage, file);
        // File-as-data reads and subprocesses are not visible as V8 script loads.
        if (/(?:['"](?:node:)?(?:fs(?:\/promises)?|fs-extra|graceful-fs|child_process|worker_threads)['"]|\bgetBuiltinModule\s*\()/u.test(await readFile(path, 'utf8')))
          return decline('external-dependency', file);
      }
    }
    return { baseline: { kind: 'jest', baseSha: input.baseSha, logPath: result.logPath, outputSha256: result.outputSha256,
      affectedTests: [...affected].sort(),
      failures: [...candidate.failures].map(([test, { errorSha256 }]) => ({ test, errorSha256 })) } };
  } catch (error) {
    if (error instanceof CommandProcessQuiescenceError) { cleanup = false; throw error; }
    return decline(stage);
  } finally {
    if (cleanup) {
      await rm(base, { recursive: true, force: true });
      await rm(archive, { force: true });
      await rm(gitDirectory, { recursive: true, force: true });
      await rm(coverage, { recursive: true, force: true });
    }
  }
}

async function readComparableReport(reportPath: string, checkout: string) {
  const reason = await readFile(reportPath + '.reason', 'utf8').catch(() => undefined);
  const diagnostic = { code: reason };
  if (validJestDiagnostic(diagnostic)) return diagnostic;
  const report = await readJestReport(reportPath, checkout).catch(() => undefined);
  if (!report) return { code: 'candidate-report' } as const;
  if ('snapshotFailure' in report) return { code: 'snapshot-failure' } as const;
  return report;
}

async function regularFile(root: string, file: string): Promise<boolean> {
  const path = join(root, file);
  try { return (await lstat(path)).isFile() && await realpath(path) === join(await realpath(root), file); }
  catch { return false; }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Infrastructure and incomplete reports never authorize an assertion exception. */
async function readJestReport(reportPath: string, checkout: string) {
  const stat = await lstat(reportPath);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return;
  const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
  if (!object(report) || report.success !== false || report.wasInterrupted !== false
    || !object(report.snapshot) || typeof report.snapshot.failure !== 'boolean'
    || report.numRuntimeErrorTestSuites !== 0 || !Array.isArray(report.testResults)
    || report.testResults.length !== report.numTotalTestSuites) return;
  if (report.snapshot.failure) return { snapshotFailure: true } as const;
  const root = await realpath(checkout);
  const passing = new Set<string>();
  const seen = new Set<string>();
  const failures = new Map<string, { file: string; errorSha256: string }>();
  let failedSuites = 0;
  for (const suite of report.testResults as unknown[]) {
    if (!object(suite) || typeof suite.name !== 'string' || !isAbsolute(suite.name)
      || !Array.isArray(suite.assertionResults) || !['passed', 'failed', 'pending', 'skipped', 'focused'].includes(String(suite.status))) return;
    const file = relative(root, suite.name);
    if (!jestEvidencePath(file) || seen.has(file)) return;
    seen.add(file);
    let failuresInSuite = 0;
    let allPassed = suite.assertionResults.length > 0;
    for (const assertion of suite.assertionResults as unknown[]) {
      if (!object(assertion) || !['passed', 'failed', 'pending', 'todo', 'disabled', 'skipped'].includes(String(assertion.status))) return;
      allPassed &&= assertion.status === 'passed';
      if (assertion.status !== 'failed') continue;
      if (typeof assertion.fullName !== 'string' || !assertion.fullName.trim()
        || !Array.isArray(assertion.failureMessages) || !assertion.failureMessages.length) return;
      const messages: string[] = [];
      for (const message of assertion.failureMessages as unknown[]) {
        if (typeof message !== 'string') return;
        const normalized = stripVTControlCharacters(message).replaceAll(root, '<root>').replaceAll(checkout, '<root>')
          .trim();
        if (!normalized) return;
        messages.push(normalized);
      }
      const test = file + ' :: ' + assertion.fullName;
      if (failures.has(test)) return;
      failures.set(test, { file, errorSha256: sha256(canonicalJson(messages)) });
      failuresInSuite++;
    }
    if ((suite.status === 'failed') !== (failuresInSuite > 0)) return;
    if (failuresInSuite) failedSuites++;
    if (allPassed && suite.status === 'passed') passing.add(file);
  }
  if (!failures.size || failures.size !== report.numFailedTests || failedSuites !== report.numFailedTestSuites) return;
  return { passing, failures, seen };
}

async function readLoadedFiles(directory: string, checkout: string): Promise<Set<string>> {
  const root = await realpath(checkout);
  const loaded = new Set<string>();
  const reports = await readdir(directory);
  if (!reports.length || reports.length > 256) throw new Error('Incomplete V8 coverage.');
  let totalBytes = 0;
  for (const report of reports) {
    if (!/^coverage-.*\.json$/u.test(report)) throw new Error('Unexpected V8 coverage file.');
    const path = join(directory, report);
    const stat = await lstat(path);
    totalBytes += stat.size;
    if (!stat.isFile() || totalBytes > 128 * 1024 * 1024) throw new Error('V8 coverage exceeds evidence limits.');
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!object(data) || !Array.isArray(data.result)) throw new Error('Invalid V8 coverage.');
    for (const entry of data.result as unknown[]) {
      if (!object(entry) || typeof entry.url !== 'string') throw new Error('Invalid V8 module URL.');
      const url = entry.url.startsWith('file:') ? fileURLToPath(entry.url) : entry.url;
      if (!isAbsolute(url)) continue;
      const file = relative(root, url);
      if (jestEvidencePath(file)) loaded.add(file);
    }
  }
  return loaded;
}
