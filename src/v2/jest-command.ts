import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function npmTestScript(command: string): RegExpExecArray | null {
  return /^npm (test|run ([A-Za-z0-9_:-]+))(?: -- ([A-Za-z0-9_./=@%, -]+))?$/u.exec(command);
}

/** Only npm scripts that invoke Jest directly without lifecycle hooks may be instrumented. */
export function jestCommand(cwd: string, command: string) {
  const match = npmTestScript(command);
  if (!match) return;
  const script = match[2] ?? 'test';
  const pkg: { scripts?: Record<string, unknown>; jest?: unknown } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (pkg.scripts?.[`pre${script}`] || pkg.scripts?.[`post${script}`]) return;
  const scriptCommand = pkg.scripts?.[script];
  if (typeof scriptCommand !== 'string' || !/^jest(?:\s+[A-Za-z0-9_./=@%, -]+)?$/u.test(scriptCommand)) return;
  const flags = [...scriptCommand.split(/\s+/u).slice(1), ...(match[3]?.split(/\s+/u) ?? [])];
  const valueFlags = new Set(['--config', '--maxWorkers', '-w', '--testTimeout']);
  for (let i = 0; i < flags.length; i++) {
    if (valueFlags.has(flags[i]!)) { if (!flags[++i] || flags[i]!.startsWith('-')) return; continue; }
    if (!/^(?:--(?:runInBand|ci|coverage|silent|verbose|detectOpenHandles|forceExit|no-cache|logHeapUsage|errorOnDeprecated|bail)(?:=(?:true|false|[0-9]+))?|--(?:config|maxWorkers|testTimeout)=[A-Za-z0-9_./%-]+)$/u.test(flags[i]!)) return;
  }
  const npmArgs = script === 'test' ? ['test'] : ['run', script];
  return { npmArgs, extra: match[3]?.split(/\s+/u) ?? [], flags, pkg };
}


export function parseJestConfig(log: string): unknown {
  return JSON.parse(log.slice(log.indexOf('{'), log.lastIndexOf('}') + 1));
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export type JestConfigurationProblem = 'configuration-output' | 'configuration-selection' | 'configuration-coverage'
  | 'configuration-reporting' | 'configuration-hooks';

export function jestConfigurationProblem(value: unknown): JestConfigurationProblem | undefined {
  if (!object(value) || !object(value.globalConfig) || !Array.isArray(value.configs) || !value.configs.length)
    return 'configuration-output';
  const global = value.globalConfig;
  if (['bail', 'changedSince', 'filter', 'findRelatedTests', 'lastCommit', 'listTests', 'onlyChanged', 'onlyFailures',
    'passWithNoTests', 'randomize', 'runTestsByPath', 'shard', 'testNamePattern', 'watch', 'watchAll'].some(key => global[key]))
    return 'configuration-selection';
  const defaultReporters = (entry: unknown): boolean => entry === undefined
    || (Array.isArray(entry) && entry.length === 1 && Array.isArray(entry[0]) && entry[0][0] === 'default');
  const hooks = ['dependencyExtractor', 'globalSetup', 'globalTeardown', 'resolver', 'runner', 'runtime',
    'setupFiles', 'setupFilesAfterEnv', 'snapshotResolver', 'snapshotSerializers', 'testEnvironment',
    'testRunner', 'testSequencer', 'transform'];
  const hasLocalModule = (entry: unknown): boolean => {
    if (Array.isArray(entry)) return entry.some(hasLocalModule);
    return typeof entry === 'string' && isAbsolute(entry) && !entry.includes('/node_modules/');
  };
  for (const config of [global, ...value.configs] as unknown[]) {
    if (!object(config)) return 'configuration-output';
    if (config.collectCoverage || config.coverageThreshold) return 'configuration-coverage';
    if (config.testResultsProcessor || !defaultReporters(config.reporters)) return 'configuration-reporting';
    if (hooks.some(hook => hasLocalModule(config[hook]))) return 'configuration-hooks';
  }
}
