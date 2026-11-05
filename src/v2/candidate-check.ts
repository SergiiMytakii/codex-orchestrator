/** Owner-invoked check: native related Jest selection, conservative full-command fallback. */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { isAbsolute, join, relative, resolve } from 'node:path';
import JSON5 from 'json5';
import { jestCommand, jestConfigurationProblem, parseJestConfig, type JestConfigurationProblem } from './jest-command.js';

const [base, command, reportPath] = process.argv.slice(2);
if (!base || !/^(?:HEAD|[0-9a-f]{40})$/u.test(base) || !command) throw new Error('Expected base SHA and configured command.');
const cwd = process.cwd();
let args: string[] | undefined;
try { args = relatedJestArgs(); } catch { /* Unknown scope retains the entire configured command. */ }
console.log(`Owner check: ${JSON.stringify({ command, invocation: args ? ['npm', ...args] : command, scope: args ? 'related-jest' : 'full' })}`);
if (reportPath && !args) {
  const result = runWithJestLog('/bin/sh', ['-c', command]);
  process.exitCode = exitCode(result);
  if (result.status === 1) collectJestReport(result.stderr);
} else {
  const result = args ? spawnSync('npm', args, { stdio: 'inherit' }) : spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit' });
  process.exitCode = exitCode(result);
  if (reportPath && result.status === 1) writeMarker('affected-suite');
}

function runWithJestLog(program: string, args: string[]) {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['inherit', 'inherit', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function exitCode(result: Pick<ReturnType<typeof spawnSync>, 'status' | 'signal'>): number {
  if (result.status !== null) return result.status;
  console.error(`Owner check: child did not exit normally${result.signal ? ` (${result.signal})` : ''}.`);
  return result.signal ? 128 + constants.signals[result.signal] : 125;
}

function writeMarker(reason: JestConfigurationProblem | 'affected-suite' | 'candidate-report' | 'replay-mismatch'): void {
  writeFileSync(reportPath + '.reason', reason, { mode: 0o600, flag: 'wx' });
}

function collectJestReport(ordinaryLog: string): void {
  let problem: JestConfigurationProblem | 'candidate-report' | 'replay-mismatch' = 'configuration-output';
  try {
    const parsed = jestCommand(cwd, command!);
    if (parsed) {
      const machine = ['--json', '--outputFile', reportPath!];
      const checkConfig = (flags: string[]) => {
        const probe = spawnSync('npm', ['--silent', ...parsed.npmArgs, '--', ...parsed.extra, '--showConfig', ...flags],
          { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
        return probe.status === 0 ? jestConfigurationProblem(parseJestConfig(probe.stdout)) : 'configuration-output';
      };
      const refusal = checkConfig([]) ?? checkConfig(machine);
      if (refusal) problem = refusal;
      else {
        const replay = runWithJestLog('npm', [...parsed.npmArgs, '--', ...parsed.extra, ...machine]);
        if (replay.status === 1) {
          const expected = jestFailureTranscript(ordinaryLog);
          if (expected && expected === jestFailureTranscript(replay.stderr)) return;
          problem = 'replay-mismatch';
        } else {
          if (replay.status === null) process.exitCode = exitCode(replay);
          problem = 'candidate-report';
        }
      }
    }
  } catch { /* Keep the result of the original check. */ }
  writeMarker(problem);
}

function jestFailureTranscript(log: string): string | undefined {
  const reportNotice = 'Test results written to: ';
  const cleaned = stripVTControlCharacters(log).replace(/\r\n/gu, '\n')
    .split('\n').filter(line => !line.startsWith(reportNotice)
      || resolve(cwd, line.slice(reportNotice.length)) !== resolve(reportPath!)).join('\n');
  const summaryStart = cleaned.lastIndexOf('\nTest Suites:');
  if (summaryStart < 0 || !/^Tests:\s+\d+ failed(?:,|$)/mu.test(cleaned.slice(summaryStart))) return;
  const summary = cleaned.slice(summaryStart).replace(/^Time:\s+.*\n/mu, '').trim();
  const output = cleaned.slice(0, summaryStart);
  const firstSuite = output.search(/^(?:FAIL|PASS|SKIP) /mu);
  if (firstSuite < 0) return;
  const prefix = output.slice(0, firstSuite).trim();
  const suites = output.slice(firstSuite).split(/(?=^(?:FAIL|PASS|SKIP) )/mu);
  if (!suites.some(suite => suite.startsWith('FAIL '))) return;
  // Worker completion order and timing can change. Preserve each suite's full
  // assertion output and the summary so a different failure cannot be waived.
  const blocks = suites.map(suite => suite.replace(/^((?:FAIL|PASS|SKIP) .+) \(\d+(?:\.\d+)? s\)(?=\n|$)/u, '$1').trimEnd());
  return JSON.stringify([prefix, blocks.sort(), summary]);
}

function git(args: string[]): string[] {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot observe the complete candidate.');
  return result.stdout.split('\0').filter(Boolean);
}

function relatedJestArgs(): string[] | undefined {
  const parsed = jestCommand(cwd, command!);
  if (!parsed) return;
  const { flags, pkg, npmArgs, extra } = parsed;
  const files = [...new Set([...git(['diff', '--no-renames', '--name-only', '-z', base!, '--']),
    ...git(['ls-files', '--others', '--exclude-standard', '-z'])])].sort();
  if (!files.length) return;
  const sources: string[] = [];
  for (const file of files) {
    if (file.startsWith('-') || isAbsolute(file) || file.split('/').some(part => part === '..')
      || !/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file)
      || /(?:^|\/)[^/]*(?:config|setup)[^/]*$/iu.test(file)) return;
    const stat = lstatSync(join(cwd, file));
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    sources.push(`./${file}`);
  }
  if (!sources.length || !staticConfig(flags, pkg)) return;
  // Probe through npm so ancestor-installed Jest resolves exactly as in the real check.
  const probe = spawnSync('npm', [...npmArgs, '--', ...extra, '--showConfig'], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  if (probe.status !== 0) return;
  const config = JSON.parse(probe.stdout.slice(probe.stdout.indexOf('{')));
  if (!Array.isArray(config.configs) || !config.configs.length || !config.globalConfig
    || ['lastCommit', 'onlyChanged', 'changedSince', 'changedFilesWithAncestor', 'onlyFailures', 'watch', 'watchAll', 'listTests', 'runTestsByPath', 'filter', 'shard']
      .some(key => config.globalConfig[key])
    || (config.globalConfig.testFailureExitCode !== undefined && config.globalConfig.testFailureExitCode <= 0)
    || [...config.configs, config.globalConfig].some(localGlobalModule)) return;
  return [...npmArgs, '--', ...extra, '--passWithNoTests=false', '--findRelatedTests', ...sources];
}

function staticConfig(flags: string[], pkg: { jest?: unknown }): boolean {
  let explicit: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--config') explicit = flags[++i];
    else if (flags[i]!.startsWith('--config=')) explicit = flags[i]!.slice(9);
  }
  const files = explicit ? [resolve(cwd, explicit)] : ['js', 'cjs', 'mjs', 'ts', 'cts', 'json']
    .map(ext => join(cwd, `jest.config.${ext}`)).filter(existsSync);
  let config: unknown;
  if (!files.length && !explicit) config = pkg.jest;
  else {
    if (files.length !== 1 || (!explicit && pkg.jest !== undefined)) return false;
    const file = files[0]!;
    if (relative(cwd, file).startsWith('..') || /(?:^|\/)\.env(?:\.|$)/u.test(file)) return false;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return false;
    const source = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) config = JSON5.parse(source);
    else {
      const body = source.replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u, '');
      const literal = /^(?:module\.exports\s*=|export\s+default)\s*([\s\S]*?)\s*;?\s*$/u.exec(body);
      if (!literal) return false;
      config = JSON5.parse(literal[1]!);
    }
  }
  return !!config && typeof config === 'object' && !Array.isArray(config) && !('preset' in config) && !('projects' in config);
}

function localGlobalModule(config: Record<string, unknown>): boolean {
  const local = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(local);
    if (value && typeof value === 'object') return Object.values(value).some(local);
    return typeof value === 'string' && isAbsolute(value) && !value.includes('/node_modules/')
      && existsSync(value) && lstatSync(value).isFile();
  };
  return Object.entries(config).some(([key, value]) => key !== 'moduleNameMapper' && local(value));
}
