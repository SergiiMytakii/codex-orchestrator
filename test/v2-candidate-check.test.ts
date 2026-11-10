import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runConfiguredChecks } from '../src/v2/runner-checks.js';

const exec = promisify(execFile);
const helper = join(import.meta.dirname, '../../dist/src/v2/candidate-check.js');

for (const mode of ['worker', 'host']) test(`${mode} check selects the complete candidate and keeps related failures blocking`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner check '));
  let sequence = 0;
  const run = async (publicRoot?: string) => {
    if (mode === 'host') {
      const baseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      const results = await runConfiguredChecks({ checks: { test: 'npm test' }, baseSha, worktreePath: root,
        relatedResources: publicRoot ? { publicRoot } : undefined,
        logRoot: join(root, 'node_modules', '.check-logs', String(sequence++)), timeoutMs: 10000,
        env: process.env, signal: new AbortController().signal });
      return { code: results[0]!.exitCode, stdout: await readFile(results[0]!.logPath, 'utf8'), stderr: '' };
    }
    try { return { code: 0, ...(await exec(process.execPath, [helper, 'HEAD', 'npm test', ...(publicRoot ? [JSON.stringify({ publicRoot })] : [])], { cwd: root })) }; }
    catch (e) { return e as { code: number; stdout: string; stderr: string }; }
  };
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest --config jest.config.js' } }));
    await writeFile(join(root, 'jest.config.js'), 'module.exports = {};');
    await writeFile(join(root, 'src/feature.ts'), 'original');
    await writeFile(join(root, '.gitignore'), 'node_modules/\nresolved-config.json\n');
    await exec('git', ['init', '-b', 'main'], { cwd: root });
    await exec('git', ['add', 'src', 'package.json', 'jest.config.js', '.gitignore'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'base'], { cwd: root });
    // Process double at the native Jest boundary: full suite has an unrelated failure.
    await writeFile(join(root, 'node_modules/.bin/jest'), `#!/bin/sh
case "$*" in
 *--showConfig*) if [ -f resolved-config.json ]; then cat resolved-config.json; else printf '{"configs":[{}],"globalConfig":{}}'; fi; exit 0;;
 *--listTests*)
  case "$*" in *./src/untested.ts*) printf '[]';; *) printf '["%s/src/feature.spec.ts"]' "$PWD";; esac
  exit 0;;
 *./src/broken.ts*) echo related-regression; exit 1;;
 *./src/empty.ts*) case "$*" in *--passWithNoTests=false*) echo empty-selection; exit 1;; esac;;
 *--findRelatedTests*)
  selected=feature
  case "$*" in *./src/skipped.spec.ts*) selected=skipped;; *./src/runtime-config.spec.ts*) selected=runtime-config;; esac
  printf '%s\\n' "$@"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --outputFile ]; then
      if [ "$selected" = skipped ]; then
        printf '{"success":true,"numPassedTests":1,"testResults":[{"status":"pending","name":"%s/src/skipped.spec.ts","assertionResults":[]}]}' "$PWD" > "$2"
      else
        printf '{"success":true,"numPassedTests":1,"testResults":[{"status":"focused","name":"%s/src/%s.spec.ts","assertionResults":[{"status":"passed"}]}]}' "$PWD" "$selected" > "$2"
      fi
      break
    fi
    shift
  done
  exit 0;;
esac
echo unrelated-failure; exit 1
`);
    await chmod(join(root, 'node_modules/.bin/jest'), 0o700);
    const unscoped = await run();
    assert.notEqual(unscoped.code, 0);
    assert.doesNotMatch(unscoped.stdout, /unrelated-failure/u, 'a missing selection must not launch the full suite');
    await writeFile(join(root, 'src/feature.ts'), 'changed');
    const selected = await run();
    assert.equal(selected.code, 0, selected.stderr);
    assert.match(selected.stdout, /--findRelatedTests/u);
    assert.match(selected.stdout, /\.\/src\/feature.ts/u);
    await writeFile(join(root, 'src/feature.ts'), "export const hero = 'url(/assets/hero.png)';");
    await mkdir(join(root, 'public/assets'), { recursive: true });
    await writeFile(join(root, 'public/assets/hero.png'), 'original image');
    await exec('git', ['add', 'src', 'public'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'image baseline'], { cwd: root });
    await writeFile(join(root, 'public/assets/hero.png'), 'new image');
    const image = await run('public');
    assert.equal(image.code, 0, image.stdout + image.stderr);
    assert.match(image.stdout, /--findRelatedTests.*\.\/src\/feature\.ts/u);
    assert.doesNotMatch(image.stdout, /unrelated-failure|\.\/public\/assets\/hero\.png/u);
    await writeFile(join(root, 'src/untested.ts'), "export const image = '/assets/untested.png';");
    await writeFile(join(root, 'public/assets/untested.png'), 'has a source dependency but no test');
    const untested = await run('public');
    assert.equal(untested.code, 1);
    assert.match(untested.stdout + untested.stderr, /Jest found no related tests for resource public\/assets\/untested\.png/u);
    await rm(join(root, 'src/untested.ts'));
    await rm(join(root, 'public/assets/untested.png'));
    await writeFile(join(root, 'public/assets/unused.png'), 'no reference');
    const unknown = await run('public');
    assert.equal(unknown.code, 1);
    assert.match(unknown.stdout + unknown.stderr, /No literal test dependency found/u);
    await rm(join(root, 'public/assets/unused.png'));
    await writeFile(join(root, 'public/assets/hero.png'), 'original image');
    await writeFile(join(root, 'src/feature.ts'), 'changed');
    await writeFile(join(root, 'src/skipped.spec.ts'), 'test skipped by its environment');
    const skipped = await run();
    assert.equal(skipped.code, 1);
    assert.match(skipped.stdout + skipped.stderr, /edited Jest suites must execute successfully/u);
    await rm(join(root, 'src/skipped.spec.ts'));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/feature.md'), 'feature documentation');
    await writeFile(join(root, 'src/runtime-config.spec.ts'), 'an ordinary app configuration test');
    const withDocs = await run();
    assert.equal(withDocs.code, 0, withDocs.stdout + withDocs.stderr);
    assert.match(withDocs.stdout, /runtime-config\.spec\.ts/u);
    assert.doesNotMatch(withDocs.stdout, /docs\/feature\.md/u);
    await rm(join(root, 'src/runtime-config.spec.ts'));
    await rm(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'src/content.mdx'), 'module.exports = 2;');
    assert.equal((await run()).code, 1, 'MDX may be imported source and must block the test check');
    await rm(join(root, 'src/content.mdx'));
    await writeFile(join(root, 'src/broken.ts'), 'untracked source');
    assert.equal((await run()).code, 1, 'untracked candidate files must participate');
    await rm(join(root, 'src/broken.ts'));
    await writeFile(join(root, 'src/empty.ts'), 'uncovered');
    assert.equal((await run()).code, 1, 'empty selections cannot pass');
    await rm(join(root, 'src/empty.ts'));
    await writeFile(join(root, 'jest.config.js'), 'module.exports = { verbose: true };');
    assert.equal((await run()).code, 1, 'config edits block the test check');
    await writeFile(join(root, 'jest.config.js'), 'module.exports = {};');
    await writeFile(join(root, 'jest.config.js'), 'module.exports = makeConfig();');
    await exec('git', ['add', 'jest.config.js'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'dynamic config baseline'], { cwd: root });
    assert.equal((await run()).code, 0, 'resolved dynamic config can still support native scope');
    await writeFile(join(root, 'jest.config.js'), 'module.exports = {};');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest --config jest.config.js', pretest: 'echo prepare' } }));
    await exec('git', ['add', 'jest.config.js', 'package.json'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'npm hook baseline'], { cwd: root });
    assert.equal((await run()).code, 1, 'unchanged lifecycle hooks block the test check');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest --config jest.config.js' } }));
    await exec('git', ['add', 'package.json'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'plain npm baseline'], { cwd: root });
    await writeFile(join(root, 'src/setup-env.cjs'), 'module.exports = {};');
    await exec('git', ['add', 'src/setup-env.cjs'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'setup baseline'], { cwd: root });
    await writeFile(join(root, 'resolved-config.json'), JSON.stringify({
      configs: [{ setupFiles: [join(root, 'src/setup-env.cjs')] }], globalConfig: {},
    }));
    assert.equal((await run()).code, 0, 'an unchanged setup file permits related tests');
    await writeFile(join(root, 'src/setup-env.cjs'), 'module.exports = { changed: true };');
    assert.notEqual((await run()).code, 0, 'a changed global setup requires an explicit selector');
    await writeFile(join(root, 'src/setup-env.cjs'), 'module.exports = {};');
    for (const flag of ['lastCommit', 'onlyChanged', 'changedSince', 'changedFilesWithAncestor', 'onlyFailures', 'watch', 'watchAll', 'listTests', 'testFailureExitCode']) {
      await writeFile(join(root, 'resolved-config.json'), JSON.stringify({ configs: [{}], globalConfig: { [flag]: flag === 'testFailureExitCode' ? 0 : true } }));
      const result = await run();
      assert.equal(result.code, 1, `${flag} must block the test check`);
      assert.match(mode === 'host' ? result.stdout : result.stderr, /cannot determine related tests/u);
      assert.doesNotMatch(result.stdout, /unrelated-failure/u);
    }
    await rm(join(root, 'resolved-config.json'));
    await rm(join(root, 'src/feature.ts'));
    assert.equal((await run()).code, 1, 'deleted source requires full checks');
  } finally { await rm(root, { recursive: true, force: true }); }
});
