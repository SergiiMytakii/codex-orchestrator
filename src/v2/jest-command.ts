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
