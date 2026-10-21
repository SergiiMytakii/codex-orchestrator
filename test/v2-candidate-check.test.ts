import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const helper = join(import.meta.dirname, '../../dist/src/v2/candidate-check.js');

test('owner check selects the complete candidate and keeps related failures blocking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owner check '));
  const run = async () => {
    try { return { code: 0, ...(await exec(process.execPath, [helper, 'HEAD', 'npm test'], { cwd: root })) }; }
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
 *./src/broken.ts*) echo related-regression; exit 1;;
 *./src/empty.ts*) case "$*" in *--passWithNoTests=false*) echo empty-selection; exit 1;; esac;;
 *--findRelatedTests*) printf '%s\\n' "$@"; exit 0;;
esac
echo unrelated-failure; exit 1
`);
    await chmod(join(root, 'node_modules/.bin/jest'), 0o700);
    assert.equal((await run()).code, 1, 'no source diff must retain full checks');
    await writeFile(join(root, 'src/feature.ts'), 'changed');
    const selected = await run();
    assert.equal(selected.code, 0, selected.stderr);
    assert.match(selected.stdout, /--findRelatedTests/u);
    assert.match(selected.stdout, /\.\/src\/feature.ts/u);
    await writeFile(join(root, 'src/content.mdx'), 'module.exports = 2;');
    assert.equal((await run()).code, 1, 'MDX may be imported source and must retain full checks');
    await rm(join(root, 'src/content.mdx'));
    await writeFile(join(root, 'src/broken.ts'), 'untracked source');
    assert.equal((await run()).code, 1, 'untracked candidate files must participate');
    await rm(join(root, 'src/broken.ts'));
    await writeFile(join(root, 'src/empty.ts'), 'uncovered');
    assert.equal((await run()).code, 1, 'empty selections cannot pass');
    await rm(join(root, 'src/empty.ts'));
    await writeFile(join(root, 'jest.config.js'), 'module.exports = { verbose: true };');
    assert.equal((await run()).code, 1, 'config edits require full checks');
    await writeFile(join(root, 'jest.config.js'), 'module.exports = {};');
    await writeFile(join(root, 'jest.config.js'), 'module.exports = makeConfig();');
    await exec('git', ['add', 'jest.config.js'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'dynamic config baseline'], { cwd: root });
    assert.equal((await run()).code, 1, 'unchanged executable config cannot establish a safe scope');
    await writeFile(join(root, 'jest.config.js'), 'module.exports = {};');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest --config jest.config.js', pretest: 'echo prepare' } }));
    await exec('git', ['add', 'jest.config.js', 'package.json'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'npm hook baseline'], { cwd: root });
    assert.equal((await run()).code, 1, 'unchanged lifecycle hooks retain full checks');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest --config jest.config.js' } }));
    await exec('git', ['add', 'package.json'], { cwd: root });
    await exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'plain npm baseline'], { cwd: root });
    for (const flag of ['lastCommit', 'onlyChanged', 'changedSince', 'changedFilesWithAncestor', 'onlyFailures', 'watch', 'watchAll', 'listTests', 'testFailureExitCode']) {
      await writeFile(join(root, 'resolved-config.json'), JSON.stringify({ configs: [{}], globalConfig: { [flag]: flag === 'testFailureExitCode' ? 0 : true } }));
      const result = await run();
      assert.equal(result.code, 1, `${flag} must retain full check failure`);
      assert.match(result.stdout, /"scope":"full"/u);
    }
    await rm(join(root, 'resolved-config.json'));
    await rm(join(root, 'src/feature.ts'));
    assert.equal((await run()).code, 1, 'deleted source requires full checks');
  } finally { await rm(root, { recursive: true, force: true }); }
});
