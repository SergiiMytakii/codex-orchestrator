import { mkdir, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { posix, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from './containment.js';
import { CommandProcessQuiescenceError } from './adapters/command.js';
import type { RunnerCheckResult } from './runner-checks.js';

export interface FlutterBaselineEvidence {
  baseSha: string;
  logPath: string;
  outputSha256: string;
  affectedTests: string[];
  failures: Array<{ test: string; errorSha256: string }>;
}

type LoggedCommand = (command: string, cwd: string, label: string) => Promise<RunnerCheckResult>;

/** Instrument only the ordinary full Flutter test command; unknown flags retain the exact policy. */
export function flutterTestCommand(command: string): { sdk: string; machine: string } | undefined {
  const match = /^(('[^'\n]+\/flutter'|"[^"\n$`]+\/flutter"|[A-Za-z0-9_./-]*flutter)) test(?: --no-pub)?$/u.exec(command);
  return match ? { sdk: match[1]!, machine: `${command} --machine` } : undefined;
}

/** Confirm unchanged test failures on an immutable base while requiring passing coverage for changed Dart code. */
export async function confirmFlutterBaseline(input: {
  command: string; candidate: RunnerCheckResult; baseSha: string; worktreePath: string; logRoot: string; run: LoggedCommand;
}): Promise<FlutterBaselineEvidence | undefined> {
  const sdk = flutterTestCommand(input.command);
  if (!sdk || input.candidate.exitCode !== 1 || !/^[a-f0-9]{40}$/u.test(input.baseSha)) return;
  const baseline = join(input.logRoot, 'baseline');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const invoke = async (command: string, cwd: string, label: string) => {
    const result = await input.run(command, cwd, label);
    if (result.exitCode !== 0) throw new Error(`Baseline preparation failed: ${label}`);
    return readFile(result.logPath, 'utf8');
  };
  const decline = async (reason: string) => {
    await writeFile(join(input.logRoot, 'baseline-diagnosis.json'), JSON.stringify({ reason }), { mode: 0o600 });
    return undefined;
  };
  let cleanup = true;
  try {
    const candidate = parseTestEvents(await readFile(input.candidate.logPath, 'utf8'), input.worktreePath);
    if (!candidate || !candidate.failures.size) return decline('Candidate test protocol is incomplete or unsupported.');
    const changes = splitPaths(await invoke(`git diff --no-ext-diff --no-renames --name-only -z ${input.baseSha} --`, input.worktreePath, 'changed'));
    const untracked = splitPaths(await invoke('git ls-files --others --exclude-standard -z', input.worktreePath, 'untracked'));
    const changed = [...new Set([...changes, ...untracked])];
    if (!changed.length || changed.some(file => !/^(?:lib|test)\/.*\.dart$/u.test(file))) return decline('Changed scope is not exclusively lib/test Dart files.');
    await mkdir(baseline, { mode: 0o700 });
    const archive = join(input.logRoot, 'baseline.tar');
    await invoke(`git archive --format=tar --output=${quote(archive)} ${input.baseSha}`, input.worktreePath, 'archive');
    await invoke(`tar -xf ${quote(archive)} -C ${quote(baseline)}`, input.worktreePath, 'extract');
    await rm(archive);
    const before = await readFile(join(baseline, 'pubspec.lock'));
    if (!(await readFile(join(input.worktreePath, 'pubspec.lock'))).equals(before)) return decline('Candidate lockfile differs from base.');
    const files = splitPaths(await invoke('git ls-files --cached --others --exclude-standard -z', input.worktreePath, 'files'));
    const baseFiles = splitPaths(await invoke(`git ls-tree -r --name-only -z ${input.baseSha}`, input.worktreePath, 'base-files'));
    const failureFiles = new Set([...candidate.failures.values()].map(failure => failure.file));
    if (changed.some(file => failureFiles.has(file))) return decline('A new or edited test file failed.');
    const passingFiles = new Set([...candidate.passedFiles].filter(file => !failureFiles.has(file)));
    if (changed.some(file => /^test\/.*_test\.dart$/u.test(file) && !passingFiles.has(file)))
      return decline('An edited test file did not execute successfully.');
    const affected = new Set<string>();
    const covered = new Set<string>();
    for (const [root, paths] of [[input.worktreePath, files], [baseline, baseFiles]] as const) {
      const impact = await affectedDartTests(root, paths, changed, passingFiles);
      for (const file of impact.tests) affected.add(file);
      for (const file of impact.covered) covered.add(file);
    }
    if (changed.some(file => !covered.has(file)) || !affected.size) return decline('Changed Dart scope lacks passing affected test coverage.');
    await invoke(`${sdk.sdk} pub get --enforce-lockfile`, baseline, 'pub-get');
    if (!(await readFile(join(baseline, 'pubspec.lock'))).equals(before)) return decline('Baseline preparation changed the lockfile.');
    const result = await input.run(sdk.machine, baseline, 'baseline-test');
    if (result.exitCode !== 1) return decline('Baseline did not finish with comparable test failures.');
    const original = parseTestEvents(await readFile(result.logPath, 'utf8'), baseline);
    if (!original || [...candidate.failures].some(([key, failure]) => original.failures.get(key)?.errorSha256 !== failure.errorSha256)) return decline('Candidate failure identities or error messages differ from base.');
    return { baseSha: input.baseSha, logPath: result.logPath, outputSha256: result.outputSha256,
      affectedTests: [...affected].sort(), failures: [...candidate.failures].map(([test, failure]) => ({ test, errorSha256: failure.errorSha256 })) };
  } catch (error) {
    // Unknown scope, malformed output and failed preparation never authorize an exception.
    if (error instanceof CommandProcessQuiescenceError) { cleanup = false; throw error; }
    return decline(error instanceof Error ? error.message : 'Baseline comparison failed.');
  } finally {
    // The archive has no Git registration or runtime ownership; keep all command logs.
    if (cleanup) {
      await rm(baseline, { recursive: true, force: true });
      await rm(join(input.logRoot, 'baseline.tar'), { force: true });
    }
  }
}

function splitPaths(value: string): string[] { return value.split('\0').filter(Boolean); }

/** Traverse both base and candidate imports/exports/parts, including conditional URIs. */
async function affectedDartTests(root: string, paths: string[], changed: string[], passingFiles: Set<string>): Promise<{ tests: Set<string>; covered: Set<string> }> {
  const name = /^name:\s*([a-zA-Z0-9_]+)\s*$/mu.exec(await readFile(join(root, 'pubspec.yaml'), 'utf8'))?.[1];
  if (!name || paths.length > 100000) throw new Error('Dart package cannot be resolved');
  const dart = paths.filter(file => /^(?:lib|test)\/.*\.dart$/u.test(file));
  const available = new Set(dart);
  const reverse = new Map<string, Set<string>>();
  for (const file of dart) {
    if (posix.normalize(file) !== file || (await lstat(join(root, file))).isSymbolicLink()) throw new Error('Unsupported Dart path');
    const source = await readFile(join(root, file), 'utf8');
    for (const uri of dartDirectiveUris(source)) {
      let dependency: string;
      if (uri.startsWith(`package:${name}/`)) dependency = `lib/${uri.slice(name.length + 9)}`;
      else if (/^(?:package:|dart:)/u.test(uri)) continue;
      else if (/[:\\?#$]/u.test(uri)) throw new Error('Unsupported Dart URI');
      else dependency = posix.normalize(posix.join(posix.dirname(file), uri));
      if (!available.has(dependency)) throw new Error(`Unresolved Dart URI in ${file}`);
      const callers = reverse.get(dependency) ?? new Set(); callers.add(file); reverse.set(dependency, callers);
    }
  }
  const tests = new Set<string>(), covered = new Set<string>();
  for (const changedFile of changed) {
    const reached = new Set([changedFile]);
    const queue = [changedFile];
    for (const file of queue) for (const caller of reverse.get(file) ?? []) {
      if (!reached.has(caller)) { reached.add(caller); queue.push(caller); }
    }
    for (const file of reached) if (/^test\/.*_test\.dart$/u.test(file) && passingFiles.has(file)) {
      tests.add(file); covered.add(changedFile);
    }
  }
  return { tests, covered };
}

/** Read the directive header only, with nested comments and string literals kept out of syntax. */
function dartDirectiveUris(source: string): string[] {
  let offset = source.startsWith('#!') ? source.indexOf('\n') : 0;
  if (offset < 0) return [];
  type Token = { text: string; literal?: boolean };
  const next = (): Token | undefined => {
    while (offset < source.length) {
      if (/\s/u.test(source[offset]!)) { offset++; continue; }
      if (source.startsWith('//', offset)) { const end = source.indexOf('\n', offset); offset = end < 0 ? source.length : end; continue; }
      if (source.startsWith('/*', offset)) {
        offset += 2; let depth = 1;
        while (depth && offset < source.length) {
          if (source.startsWith('/*', offset)) { depth++; offset += 2; }
          else if (source.startsWith('*/', offset)) { depth--; offset += 2; }
          else offset++;
        }
        if (depth) throw new Error('Unclosed Dart comment');
        continue;
      }
      break;
    }
    if (offset >= source.length) return;
    const raw = source[offset] === 'r' && /['"]/u.test(source[offset + 1] ?? '');
    if (raw) offset++;
    const quote = source[offset]!;
    if (quote === "'" || quote === '"') {
      const delimiter = source.startsWith(quote.repeat(3), offset) ? quote.repeat(3) : quote;
      offset += delimiter.length; let text = '';
      while (offset < source.length && !source.startsWith(delimiter, offset)) {
        if (!raw && source[offset] === '\\') {
          text += source.slice(offset, offset + 2); offset += 2;
        } else text += source[offset++];
      }
      if (offset >= source.length) throw new Error('Unclosed Dart literal');
      offset += delimiter.length; return { text, literal: true };
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(offset));
    if (word) { offset += word[0].length; return { text: word[0] }; }
    return { text: source[offset++]! };
  };
  const uris: string[] = [];
  let token = next();
  while (token) {
    if (token.text === '@' && !token.literal) {
      // Metadata may precede a directive; skip its qualified name and arguments.
      token = next();
      if (!token || !/^[A-Za-z_$]/u.test(token.text) || token.literal) throw new Error('Unsupported Dart annotation');
      token = next();
      while (token?.text === '.') { next(); token = next(); }
      if (token?.text === '(') {
        let depth = 1;
        while (depth) {
          token = next(); if (!token) throw new Error('Unclosed Dart annotation');
          if (!token.literal && token.text === '(') depth++;
          if (!token.literal && token.text === ')') depth--;
        }
        token = next();
      }
      continue;
    }
    if (token.literal || !['library', 'import', 'export', 'part'].includes(token.text)) break;
    const directive = token.text;
    let complete = false;
    while ((token = next())) {
      if (!token.literal && token.text === ';') { complete = true; break; }
      if (token.literal && directive !== 'library') {
        if (/[\\$]/u.test(token.text)) throw new Error('Unsupported Dart directive literal');
        uris.push(token.text);
      }
    }
    if (!complete) throw new Error('Unclosed Dart directive');
    token = next();
  }
  return uris;
}

interface TestEvents {
  failures: Map<string, { file: string; errorSha256: string }>;
  passedFiles: Set<string>;
}

/** Accept a complete test protocol with identified failures; infrastructure output is fail-closed. */
function parseTestEvents(log: string, root: string): TestEvents | undefined {
  const suites = new Map<number, string>();
  const tests = new Map<number, { name: string; file: string; errors: string[]; done: boolean }>();
  const failures: TestEvents['failures'] = new Map();
  const passedFiles = new Set<string>();
  let done = false, started = false;
  for (const line of log.split('\n').filter(line => line.trim())) {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (done) return;
    if (event.type === 'start') started = true;
    if (event.type === 'suite') {
      let path = event.suite?.path;
      if (typeof path !== 'string') return;
      if (path.startsWith('file:')) path = fileURLToPath(path);
      const normalized = path.replaceAll('/private/var/', '/var/');
      const prefix = root.replaceAll('/private/var/', '/var/') + '/';
      if (!normalized.startsWith(prefix)) return;
      suites.set(event.suite.id, normalized.slice(prefix.length));
    }
    if (event.type === 'testStart') {
      const file = suites.get(event.test?.suiteID);
      if (!file || typeof event.test.name !== 'string' || tests.has(event.test.id)) return;
      tests.set(event.test.id, { name: event.test.name.replaceAll(root, '<root>'), file, errors: [], done: false });
    }
    if (event.type === 'error') {
      const test = tests.get(event.testID);
      if (!test || typeof event.error !== 'string') return;
      test.errors.push(event.error.replaceAll(root, '<root>').replaceAll(root.replaceAll('/var/', '/private/var/'), '<root>'));
    }
    if (event.type === 'testDone') {
      const test = tests.get(event.testID);
      if (!test || test.done || !['success', 'failure', 'error'].includes(event.result)) return;
      test.done = true;
      if (event.result !== 'success') {
        if (!test.errors.length || event.skipped) return;
        const key = `${test.file} :: ${test.name}`;
        if (failures.has(key)) return;
        failures.set(key, { file: test.file, errorSha256: sha256(canonicalJson(test.errors)) });
      } else if (test.errors.length) return;
      else if (!event.skipped && !event.hidden) passedFiles.add(test.file);
    }
    if (event.type === 'done') { if (event.success !== false) return; done = true; }
  }
  return started && done && tests.size && [...tests.values()].every(test => test.done) && failures.size ? { failures, passedFiles } : undefined;
}
