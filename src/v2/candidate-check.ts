/** Owner-invoked check: native related Jest selection, conservative full-command fallback. */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import JSON5 from 'json5';

const [base, command] = process.argv.slice(2);
if (!base || !/^(?:HEAD|[0-9a-f]{40})$/u.test(base) || !command) throw new Error('Expected base SHA and configured command.');
const cwd = process.cwd();
let args: string[] | undefined;
try { args = relatedJestArgs(); } catch { /* Unknown scope retains the entire configured command. */ }
console.log(`Owner check: ${JSON.stringify({ command, invocation: args ? ['npm', ...args] : command, scope: args ? 'related-jest' : 'full' })}`);
const result = args ? spawnSync('npm', args, { stdio: 'inherit' }) : spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit' });
// Signal termination and launch failure never become a successful receipt.
process.exitCode = result.status ?? 1;

function git(args: string[]): string[] {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot observe the complete candidate.');
  return result.stdout.split('\0').filter(Boolean);
}

function relatedJestArgs(): string[] | undefined {
  // Only plain npm scripts and familiar Jest flags can be safely narrowed.
  const match = /^npm (test|run ([A-Za-z0-9_:-]+))(?: -- ([A-Za-z0-9_./=@%, -]+))?$/u.exec(command!);
  if (!match) return;
  const script = match[2] ?? 'test';
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (pkg.scripts?.[`pre${script}`] || pkg.scripts?.[`post${script}`]) return;
  const scriptCommand = pkg.scripts?.[script];
  if (typeof scriptCommand !== 'string' || !/^jest(?:\s+[A-Za-z0-9_./=@%, -]+)?$/u.test(scriptCommand)) return;
  const flags = [...scriptCommand.split(/\s+/u).slice(1), ...(match[3]?.split(/\s+/u) ?? [])];
  const valueFlags = new Set(['--config', '--maxWorkers', '-w', '--testTimeout']);
  for (let i = 0; i < flags.length; i++) {
    if (valueFlags.has(flags[i]!)) { if (!flags[++i] || flags[i]!.startsWith('-')) return; continue; }
    if (!/^(?:--(?:runInBand|ci|coverage|silent|verbose|detectOpenHandles|forceExit|no-cache|logHeapUsage|errorOnDeprecated|bail)(?:=(?:true|false|[0-9]+))?|--(?:config|maxWorkers|testTimeout)=[A-Za-z0-9_./%-]+)$/u.test(flags[i]!)) return;
  }
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
  const npmArgs = script === 'test' ? ['test'] : ['run', script];
  const extra = match[3]?.split(/\s+/u) ?? [];
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
