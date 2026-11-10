import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runConfiguredChecks } from '../src/v2/runner-checks.js';

/** A real Git baseline and fake SDK exercise the same trusted host command seam. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'flutter-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const sdk = join(root, 'sdk');
  await mkdir(repo); await mkdir(sdk);
  for (const directory of ['lib', 'test']) await mkdir(join(repo, directory));
  await writeFile(join(repo, 'pubspec.yaml'), 'name: sample\n');
  await writeFile(join(repo, 'pubspec.lock'), 'locked\n');
  await writeFile(join(repo, 'lib/feature.dart'), 'const value = 1;\n');
  await writeFile(join(repo, 'lib/other.dart'), 'const other = 1;\n');
  await writeFile(join(repo, 'test/feature_test.dart'), "import 'package:sample/feature.dart';\n");
  await writeFile(join(repo, 'test/other_test.dart'), "import '../lib/other.dart';\n");
  await writeFile(join(repo, 'test/flutter_test_config.dart'), "import '../lib/other.dart';\n");
  const flutter = join(sdk, 'flutter');
  await writeFile(flutter, `#!/usr/bin/env node
const fs = require('node:fs');
const selected = process.argv.slice(2).filter(arg => arg.endsWith('_test.dart'));
console.log('Flutter suites: ' + (selected.join(' ') || 'full suite'));
process.exit(!selected.length || selected.some(file => fs.readFileSync(file, 'utf8').includes('// failing')) ? 1 : 0);
`);
  await chmod(flutter, 0o755);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const baseSha = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'lib/feature.dart'), 'const value = 2;\n');
  const input = { checks: { test: `'${flutter}' test --no-pub`, 'check:after': 'printf reached' }, worktreePath: repo,
    baseSha, logRoot: join(root, 'logs'), timeoutMs: 10000, signal: new AbortController().signal, env: process.env };
  return { root, repo, flutter, input, git };
}

test('Flutter runs only tests that import the changed Dart source', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'test/other_test.dart'), "import '../lib/other.dart';\n// failing\n");
  f.git('add', 'test/other_test.dart'); f.git('commit', '-qm', 'unrelated failing test');
  // Pin a base with the unrelated test but the original feature source.
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  const results = await runConfiguredChecks(f.input);
  assert.deepEqual(results.map(r => [r.id, r.exitCode]), [['test', 0], ['check:after', 0]]);
  assert.equal((await readFile(results[0]!.logPath, 'utf8')).trim(), 'Flutter suites: test/feature_test.dart');
});

test('Flutter related failure blocks later checks, including a failure present on the base', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'test/feature_test.dart'), "import '../lib/feature.dart';\n// failing\n");
  f.git('add', 'test/feature_test.dart'); f.git('commit', '-qm', 'existing failure');
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  const results = await runConfiguredChecks(f.input);
  assert.deepEqual(results.map(r => [r.id, r.exitCode]), [['test', 1]]);
  assert.equal((await readFile(results[0]!.logPath, 'utf8')).trim(), 'Flutter suites: test/feature_test.dart');
  assert.equal(results[0]!.baseline, undefined);
});

for (const scenario of ['unsupported-change', 'uncovered-change', 'unknown-flags'] as const) {
  test(`Flutter never runs the full suite when selection fails: ${scenario}`, async t => {
    const f = await fixture(t);
    if (scenario === 'unsupported-change') await writeFile(join(f.repo, 'pubspec.yaml'), 'name: sample\nversion: 1.0.0\n');
    if (scenario === 'uncovered-change') await writeFile(join(f.repo, 'lib/untested.dart'), 'const untested = 1;');
    if (scenario === 'unknown-flags') f.input.checks.test += ' --coverage';
    const results = await runConfiguredChecks(f.input);
    assert.deepEqual(results.map(r => [r.id, r.exitCode]), [['test', 1]]);
    const log = await readFile(results[0]!.logPath, 'utf8');
    assert.match(log, /cannot determine related tests/u);
    assert.doesNotMatch(log, /Flutter suites:/u);
  });
}

test('Flutter includes tests using transitive conditional exports', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'lib/bridge.dart'), "export 'other.dart' if (dart.library.io) 'feature.dart';\n");
  await writeFile(join(f.repo, 'test/other_test.dart'), "import '../lib/bridge.dart';\n");
  f.git('add', 'lib/bridge.dart', 'test/other_test.dart'); f.git('commit', '-qm', 'conditional baseline');
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  const results = await runConfiguredChecks(f.input);
  assert.match(await readFile(results[0]!.logPath, 'utf8'), /Flutter suites: test\/feature_test.dart test\/other_test.dart/u);
});

test('a dependency of Flutter shared setup affects every test that loads it', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 1;\n');
  await writeFile(join(f.repo, 'lib/other.dart'), 'const other = 2;\n');
  const [result] = await runConfiguredChecks(f.input);
  assert.match(await readFile(result!.logPath, 'utf8'), /Flutter suites: test\/feature_test.dart test\/other_test.dart/u);
});

test('Flutter links each test to its nearest shared setup', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 1;\n');
  await mkdir(join(f.repo, 'test/nested'));
  await writeFile(join(f.repo, 'test/nested/flutter_test_config.dart'), "import '../../lib/feature.dart';\n");
  await writeFile(join(f.repo, 'test/nested/nested_test.dart'), "import '../../lib/other.dart';\n");
  f.git('add', '.'); f.git('commit', '-qm', 'nested setup baseline');
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 2;\n');
  const [result] = await runConfiguredChecks(f.input);
  assert.equal((await readFile(result!.logPath, 'utf8')).trim(), 'Flutter suites: test/feature_test.dart test/nested/nested_test.dart');
});

test('Flutter resolves image and changed catalog keys to related test paths', async t => {
  const f = await fixture(t);
  await mkdir(join(f.repo, 'assets/images'), { recursive: true });
  await mkdir(join(f.repo, 'assets/translations'), { recursive: true });
  await writeFile(join(f.repo, 'assets/images/feature.png'), 'before');
  await writeFile(join(f.repo, 'assets/translations/en.json'), '{"feature.title":"before","next":"before","other.title":"unchanged"}');
  await writeFile(join(f.repo, 'lib/feature.dart'), "const image = 'assets/images/feature.png';\nString title(dynamic context) => context.translate('feature.title');\nString next(dynamic context) => context.translate('next');\n");
  await writeFile(join(f.repo, 'lib/other.dart'), "const cursor = 'next';\n");
  f.git('add', '.'); f.git('commit', '-qm', 'resource baseline');
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.repo, 'assets/images/feature.png'), 'after');
  await writeFile(join(f.repo, 'assets/translations/en.json'), '{"feature.title":"after","next":"after","other.title":"unchanged"}');
  const [result] = await runConfiguredChecks(Object.assign(f.input, {
    relatedResources: { imageRoot: 'assets/images', catalogRoot: 'assets/translations' },
  }));
  assert.equal(result!.exitCode, 0);
  assert.equal((await readFile(result!.logPath, 'utf8')).trim(), 'Flutter suites: test/feature_test.dart');
});

test('Flutter selects a catalog parity test using a literal key namespace', async t => {
  const f = await fixture(t);
  await mkdir(join(f.repo, 'assets/translations'), { recursive: true });
  await writeFile(join(f.repo, 'assets/translations/en.json'), '{"feature.label":"before"}');
  await writeFile(join(f.repo, 'test/feature_test.dart'), "const catalog = 'assets/translations/en.json';\nbool inScope(String key) => key.startsWith('feature.');\n");
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 1;\n');
  f.git('add', '.'); f.git('commit', '-qm', 'catalog contract baseline');
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.repo, 'assets/translations/en.json'), '{}');
  const [result] = await runConfiguredChecks(Object.assign(f.input, { relatedResources: { catalogRoot: 'assets/translations' } }));
  assert.equal(result!.exitCode, 0);
  assert.equal((await readFile(result!.logPath, 'utf8')).trim(), 'Flutter suites: test/feature_test.dart');
});
