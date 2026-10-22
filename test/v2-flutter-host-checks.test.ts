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
  const flutter = join(sdk, 'flutter');
  await writeFile(flutter, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'pub') process.exit(0);
if (!process.argv.includes('--machine')) { console.log('Some tests failed.'); process.exit(1); }
const changed = fs.readFileSync('lib/feature.dart', 'utf8').includes('= 2');
const emit = value => console.log(JSON.stringify(value));
emit({type:'start', protocolVersion:'0.1.0'});
for (const [id,file] of [[1,'feature'],[2,'other']]) {
 emit({type:'suite',suite:{id,path:process.cwd()+'/test/'+file+'_test.dart'}});
 emit({type:'testStart',test:{id,suiteID:id,name:file+' works'}});
 const failed = file === 'other';
 if (failed) emit({type:'error',testID:id,error:'Expected true, actual false',stackTrace:'',isFailure:true});
 emit({type:'testDone',testID:id,result:failed?'failure':'success',skipped:false,hidden:false});
}
emit({type:'done',success:false});
process.exit(1);
`);
  await chmod(flutter, 0o755);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const baseSha = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'lib/feature.dart'), 'const value = 2;\n');
  const input = { checks: { test: `'${flutter}' test --no-pub`, after: 'printf reached' }, worktreePath: repo,
    baseSha, logRoot: join(root, 'logs'), timeoutMs: 10000, signal: new AbortController().signal, env: process.env };
  return { root, repo, flutter, input, git };
}

test('confirmed baseline failure outside changed Dart dependencies does not block later host checks', async t => {
  const f = await fixture(t);
  const results = await runConfiguredChecks(f.input);
  assert.deepEqual(results.map(r => r.id), ['test', 'after']);
  assert.equal(results[0]!.exitCode, 1, 'retain real failed exit status');
  const baseline = (results[0] as any).baseline;
  assert.equal(baseline.baseSha, f.input.baseSha);
  assert.equal(baseline.failures.length, 1);
  assert.deepEqual(baseline.affectedTests, ['test/feature_test.dart']);
  assert.match(await readFile(baseline.logPath, 'utf8'), /Expected true/);
  assert.equal(f.git('status', '--porcelain'), 'M lib/feature.dart', 'baseline execution preserves candidate');
});

for (const scenario of ['new-error', 'changed-test-error', 'incomplete-output', 'baseline-prepare-fails', 'unsupported-change', 'no-affected-test', 'unknown-flags'] as const) {
  test(`Flutter host baseline exception rejects ${scenario}`, async t => {
    const f = await fixture(t);
    let sdk = await readFile(f.flutter, 'utf8');
    if (scenario === 'new-error') sdk = sdk.replace("error:'Expected true, actual false'", "error:changed?'New regression':'Expected true, actual false'");
    if (scenario === 'changed-test-error') {
      sdk = sdk.replace("file === 'other'", "true");
      await writeFile(join(f.repo, 'test/feature_test.dart'), "import 'package:sample/feature.dart';\n// edited regression test\n");
    }
    if (scenario === 'incomplete-output') sdk = sdk.replace("emit({type:'done',success:false});", "if (!changed) emit({type:'done',success:false});");
    if (scenario === 'baseline-prepare-fails') sdk = sdk.replace("process.argv[2] === 'pub') process.exit(0)", "process.argv[2] === 'pub') process.exit(3)");
    if (scenario === 'unsupported-change') await writeFile(join(f.repo, 'pubspec.yaml'), 'name: sample\nversion: 1.0.0\n');
    if (scenario === 'no-affected-test') await writeFile(join(f.repo, 'lib/untested.dart'), 'const untested = 1;');
    if (scenario === 'no-affected-test') await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 1;\n');
    if (scenario === 'unknown-flags') f.input.checks.test += ' --coverage';
    await writeFile(f.flutter, sdk);
    const results = await runConfiguredChecks(f.input);
    assert.deepEqual(results.map(r => r.id), ['test']);
    assert.equal(results[0]!.exitCode, 1);
    assert.equal(results[0]!.baseline, undefined);
  });
}

test('conditional exports carry passing affected coverage while new failures remain blocking', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 1;\n');
  await writeFile(join(f.repo, 'lib/bridge.dart'), "export 'other.dart' if (dart.library.io) 'feature.dart';\n");
  await writeFile(join(f.repo, 'test/other_test.dart'), "import '../lib/bridge.dart';\n");
  f.git('add', '.'); f.git('commit', '-qm', 'conditional baseline');
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 2;\n');
  await writeFile(f.flutter, (await readFile(f.flutter, 'utf8')).replace("error:'Expected true, actual false'", "error:changed?'New regression':'Expected true, actual false'"));
  const results = await runConfiguredChecks(f.input);
  assert.equal(results[0]!.baseline, undefined, 'transitive baseline import relationships never excuse a new failure');
});

test('one covered change cannot hide an additional uncovered Dart change', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'lib/uncovered.dart'), 'const extra = 1;');
  const results = await runConfiguredChecks(f.input);
  assert.equal(results[0]!.baseline, undefined);
  assert.deepEqual(results.map(r => r.id), ['test']);
});

test('commented imports cannot claim passing coverage for changed Dart code', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 1;\n');
  await writeFile(join(f.repo, 'test/feature_test.dart'), "// import 'package:sample/feature.dart';\nconst example = \"import '../lib/feature.dart';\";\n");
  f.git('add', '.'); f.git('commit', '-qm', 'comment is not a dependency');
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 2;\n');
  const results = await runConfiguredChecks(f.input);
  assert.equal(results[0]!.baseline, undefined);
  assert.deepEqual(results.map(r => r.id), ['test']);
});

test('an edited test needs its own successful execution even when a passing test imports it', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 1;\n');
  await writeFile(join(f.repo, 'test/green_test.dart'), "import 'feature_test.dart';\n");
  f.git('add', '.'); f.git('commit', '-qm', 'test importer baseline');
  f.input.baseSha = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.repo, 'lib/feature.dart'), 'const value = 2;\n');
  await writeFile(join(f.repo, 'test/feature_test.dart'), "import 'package:sample/feature.dart';\n// edited test\n");
  await writeFile(f.flutter, (await readFile(f.flutter, 'utf8')).replace("[1,'feature']", "[1,'green']"));
  const results = await runConfiguredChecks(f.input);
  assert.equal(results[0]!.baseline, undefined);
});
