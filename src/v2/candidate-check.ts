/** Owner-invoked Jest check. A missing selection never runs the full suite. */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expandRelatedResources, isDocumentationPath, type RelatedResources } from './affected-test-paths.js';
import { jestCommand } from './jest-command.js';

const [base, command, resourceRules] = process.argv.slice(2);
if (!base || !/^(?:HEAD|[0-9a-f]{40})$/u.test(base) || !command) throw new Error('Expected base SHA and configured command.');
const cwd = process.cwd();
let selection: { args: string[]; editedTests: string[]; resourceTests: Map<string, string[]> } | 'documentation' | undefined;
try { selection = await relatedJestArgs(); }
catch (error) {
  console.error('Runner: could not inspect the candidate or resolve Jest configuration:', error instanceof Error ? error.message : error);
}
if (!selection) {
  console.error('Runner: cannot determine related tests. Configure an affected-test command for this project.');
  process.exitCode = 1;
} else if (selection === 'documentation') {
  console.log('Runner: no related tests for a documentation-only change.');
} else {
  const reportDir = mkdtempSync(join(tmpdir(), 'codex-related-jest-'));
  try {
    const report = join(reportDir, 'results.json');
    const args = [...selection.args, '--json', '--outputFile', report];
    console.log(`Owner check: ${JSON.stringify({ command, invocation: ['npm', ...args], scope: 'related-jest' })}`);
    const result = spawnSync('npm', args, { stdio: 'inherit' });
    process.exitCode = result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 125);
    if (process.exitCode === 0 && !passingRelatedTests(report, selection.editedTests, selection.resourceTests)) process.exitCode = 1;
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function passingRelatedTests(report: string, editedTests: string[], resourceTests: Map<string, string[]>): boolean {
  try {
    const result = JSON.parse(readFileSync(report, 'utf8'));
    if (result.success === true && result.numPassedTests > 0 && Array.isArray(result.testResults)) {
      const passing = new Set(result.testResults.filter((suite: { assertionResults: Array<{ status: string }> }) => suite.assertionResults.some(test => test.status === 'passed'))
        .map((suite: { name: string }) => relative(cwd, suite.name)));
      const skipped = editedTests.filter(file => !passing.has(file));
      const unverifiedResources = [...resourceTests].filter(([, tests]) => !tests.some(test => passing.has(test))).map(([file]) => file);
      if (skipped.length) console.error(`Runner: edited Jest suites must execute successfully: ${skipped.join(', ')}.`);
      if (unverifiedResources.length) console.error(`Runner: no passing Jest suite for resources: ${unverifiedResources.join(', ')}.`);
      return !skipped.length && !unverifiedResources.length;
    }
  } catch { /* Missing or incomplete test output cannot establish passing coverage. */ }
  console.error('Runner: related Jest verification did not record any passing tests.');
  return false;
}

function git(args: string[]): string[] {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot observe the complete candidate.');
  return result.stdout.split('\0').filter(Boolean);
}

async function relatedJestArgs(): Promise<typeof selection> {
  const parsed = jestCommand(cwd, command!);
  if (!parsed) return;
  const { flags, npmArgs, extra } = parsed;
  const diff = [...new Set([...git(['diff', '--no-renames', '--name-only', '-z', base!, '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z'])])].sort();
  if (!diff.length) return;
  const candidate = diff.filter(file => !isDocumentationPath(file));
  const rules = resourceRules ? JSON.parse(resourceRules) as RelatedResources : undefined;
  const expanded = rules ? await expandRelatedResources({ root: cwd, changed: candidate,
    paths: git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    rules, language: 'jest',
  }) : undefined;
  const files = expanded?.paths ?? candidate;
  if (!files.length) return 'documentation';
  const sources: string[] = [];
  for (const file of files) {
    const importedCatalog = rules?.catalogRoot && file.startsWith(rules.catalogRoot + '/') && file.endsWith('.json');
    if (file.startsWith('-') || isAbsolute(file) || file.split('/').some(part => part === '..')
      || (!importedCatalog && !/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file))
      || /(?:^|\/)jest\.(?:config|setup)\.[cm]?[jt]s$/iu.test(file)) return;
    const stat = lstatSync(join(cwd, file));
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    sources.push(`./${file}`);
  }
  if (!sources.length) return;
  // Probe through npm so ancestor-installed Jest resolves exactly as in the real check.
  const probe = spawnSync('npm', [...npmArgs, '--', ...extra, '--showConfig'], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  if (probe.status !== 0) {
    process.stderr.write(probe.stderr || probe.error?.message || 'Could not resolve Jest configuration.\n');
    return;
  }
  const config = JSON.parse(probe.stdout.slice(probe.stdout.indexOf('{')));
  if (!Array.isArray(config.configs) || !config.configs.length || !config.globalConfig
    || ['lastCommit', 'onlyChanged', 'changedSince', 'changedFilesWithAncestor', 'onlyFailures', 'watch', 'watchAll', 'listTests', 'runTestsByPath', 'filter', 'shard']
      .some(key => config.globalConfig[key])
    || (config.globalConfig.testFailureExitCode !== undefined && config.globalConfig.testFailureExitCode <= 0)
    || [...config.configs, config.globalConfig].some(localGlobalModule)) return;
  const explicitConfig = flags.flatMap((flag, i) => flag === '--config' ? [flags[i + 1]]
    : flag.startsWith('--config=') ? [flag.slice('--config='.length)] : []);
  const setupPaths = config.configs.flatMap((project: { setupFiles?: string[]; setupFilesAfterEnv?: string[] }) =>
    [...(project.setupFiles ?? []), ...(project.setupFilesAfterEnv ?? [])]);
  const changedPaths = new Set(files.map(file => resolve(cwd, file)));
  if ([...explicitConfig, ...setupPaths].some(path => path && changedPaths.has(resolve(cwd, path)))) return;
  // Refuse changed paths outside the resolved module roots. An aggregate
  // related query can otherwise quietly omit them when other files match.
  const roots = config.configs.flatMap((project: { roots?: string[] }) => project.roots ?? [cwd]);
  if (sources.some(file => !roots.some((root: string) => {
    const within = relative(root, join(cwd, file));
    return within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within);
  }))) return;
  // A test for a second asset must not hide an untested resource dependency.
  const checked = new Map<string, string[]>();
  const resourceTests = new Map<string, string[]>();
  const groups = expanded?.resources ?? new Map<string, Set<string>>();
  for (const file of files) {
    if (rules?.catalogRoot && file.startsWith(rules.catalogRoot + '/') && file.endsWith('.json')) groups.set(file, new Set([file]));
  }
  for (const [resource, dependencies] of groups) {
    const inputs = [...dependencies].sort().map(path => `./${path}`);
    const key = JSON.stringify(inputs);
    let paths = checked.get(key);
    if (!paths) {
      const listed = spawnSync('npm', ['--silent', ...npmArgs, '--', ...extra,
        '--listTests', '--json', '--findRelatedTests', ...inputs], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
      const related: unknown = listed.status === 0 ? JSON.parse(listed.stdout) : undefined;
      if (!Array.isArray(related) || !related.length || related.some(path => typeof path !== 'string' || !isAbsolute(path)))
        throw new Error(`Jest found no related tests for resource ${resource}.`);
      paths = related.map(path => relative(cwd, path));
      checked.set(key, paths);
    }
    resourceTests.set(resource, paths);
  }
  const editedTests = files.filter(file => /(?:^|\/)__tests__\/|\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file));
  return { args: [...npmArgs, '--', ...extra, '--passWithNoTests=false', '--findRelatedTests', ...sources], editedTests, resourceTests };
}

function localGlobalModule(config: Record<string, unknown>): boolean {
  const local = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(local);
    if (value && typeof value === 'object') return Object.values(value).some(local);
    return typeof value === 'string' && isAbsolute(value) && !value.includes('/node_modules/')
      && existsSync(value) && lstatSync(value).isFile();
  };
  return Object.entries(config).some(([key, value]) => key !== 'moduleNameMapper' && key !== 'setupFiles' && key !== 'setupFilesAfterEnv' && local(value));
}
