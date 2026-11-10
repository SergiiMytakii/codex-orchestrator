import { lstat, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

export function flutterTestCommand(command: string): { sdk: string } | undefined {
  const match = /^(('[^'\n]+\/flutter'|"[^"\n$`]+\/flutter"|[A-Za-z0-9_./-]*flutter)) test(?: --no-pub)?$/u.exec(command);
  return match ? { sdk: match[1]! } : undefined;
}

export async function selectRelatedFlutterTests(root: string, paths: string[], changed: string[]): Promise<string[]> {
  const scope = /^(?:(?:lib|test)\/[\w./-]+\.dart|flutter_test_config\.dart)$/u;
  const available = new Set(paths);
  if (!changed.length || changed.some(file => !scope.test(file) || !available.has(file))
    || paths.some(file => /^(?:lib|test)\/.*\.dart$/u.test(file) && !scope.test(file))) return [];
  const testFiles = new Set(paths.filter(file => /^test\/.*_test\.dart$/u.test(file)));
  const selection = await affectedDartTests(root, paths, changed, testFiles);
  return selection.covered.size === changed.length ? [...selection.tests].sort() : [];
}

/** Traverse candidate imports, exports and parts, including conditional URIs. */
async function affectedDartTests(root: string, paths: string[], changed: string[], testFiles: Set<string>): Promise<{ tests: Set<string>; covered: Set<string> }> {
  const name = /^name:\s*([a-zA-Z0-9_]+)\s*$/mu.exec(await readFile(join(root, 'pubspec.yaml'), 'utf8'))?.[1];
  if (!name || paths.length > 100000) throw new Error('Dart package cannot be resolved');
  const dart = paths.filter(file => /^(?:(?:lib|test)\/.*\.dart|flutter_test_config\.dart)$/u.test(file));
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
  for (const test of testFiles) {
    for (let directory = posix.dirname(test); ; directory = posix.dirname(directory)) {
      const bootstrap = posix.join(directory, 'flutter_test_config.dart');
      if (available.has(bootstrap)) {
        const callers = reverse.get(bootstrap) ?? new Set();
        callers.add(test);
        reverse.set(bootstrap, callers);
        break;
      }
      if (directory === '.') break;
    }
  }
  const tests = new Set<string>(), covered = new Set<string>();
  for (const changedFile of changed) {
    const reached = new Set([changedFile]);
    const queue = [changedFile];
    for (const file of queue) for (const caller of reverse.get(file) ?? []) {
      if (!reached.has(caller)) { reached.add(caller); queue.push(caller); }
    }
    for (const file of reached) if (/^test\/.*_test\.dart$/u.test(file) && testFiles.has(file)) {
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
