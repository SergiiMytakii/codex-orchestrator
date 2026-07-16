#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function packageManager(root) {
  if (existsSync(`${root}/pnpm-lock.yaml`)) return ['pnpm', 'pnpm-lock.yaml'];
  if (existsSync(`${root}/yarn.lock`)) return ['yarn', 'yarn.lock'];
  if (existsSync(`${root}/bun.lockb`) || existsSync(`${root}/bun.lock`)) return ['bun', 'bun lockfile'];
  if (existsSync(`${root}/package-lock.json`)) return ['npm', 'package-lock.json'];
  return ['npm', 'package.json fallback'];
}

export function detect(rootInput) {
  const root = resolve(rootInput);
  const candidates = [];
  const add = (command, confidence, reason) => {
    if (!candidates.some((item) => item.command === command)) candidates.push({ command, confidence, reason });
  };
  if (existsSync(`${root}/package.json`)) {
    const data = readJson(`${root}/package.json`) ?? {};
    const scripts = data.scripts && typeof data.scripts === 'object' ? data.scripts : {};
    const [manager, managerReason] = packageManager(root);
    for (const name of ['test', 'test:unit', 'test:integration', 'test:e2e']) {
      if (name in scripts) add(manager === 'npm' ? `npm run ${name}` : `${manager} run ${name}`, 'high', `package.json defines scripts.${name}; package manager from ${managerReason}`);
    }
    if (!('test' in scripts)) add(manager === 'npm' ? 'npm test' : `${manager} test`, 'medium', `package.json exists but scripts.test was not found; package manager from ${managerReason}`);
  }
  if (['pytest.ini', 'tox.ini', 'noxfile.py'].some((name) => existsSync(`${root}/${name}`))) add('python -m pytest', 'high', 'pytest/tox/nox configuration found');
  else if (existsSync(`${root}/pyproject.toml`)) {
    const text = readFileSync(`${root}/pyproject.toml`, 'utf8');
    add('python -m pytest', text.includes('pytest') || text.includes('[tool.pytest') ? 'high' : 'medium', text.includes('pytest') || text.includes('[tool.pytest') ? 'pyproject.toml contains pytest configuration' : 'pyproject.toml exists; no stronger Python test command found');
  } else if (existsSync(`${root}/requirements.txt`) && readFileSync(`${root}/requirements.txt`, 'utf8').toLowerCase().includes('pytest')) add('python -m pytest', 'high', 'requirements.txt includes pytest');
  if (existsSync(`${root}/go.mod`)) add('go test ./...', 'high', 'go.mod found');
  if (existsSync(`${root}/Cargo.toml`)) add('cargo test', 'high', 'Cargo.toml found');
  if (existsSync(`${root}/pubspec.yaml`)) add('flutter test', 'medium', 'pubspec.yaml found; use dart test if this is not a Flutter project');
  return {
    ok: true,
    cwd: root,
    candidates,
    safety: { read_only: true, tests_executed: false, files_modified: false, env_files_read: false },
    notes: candidates.length > 0 ? [] : ['No likely test command found from local manifest/config evidence.'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--cwd');
  const cwd = index >= 0 ? process.argv[index + 1] : '.';
  if (!cwd) { process.stderr.write('--cwd requires a value\n'); process.exitCode = 2; }
  else process.stdout.write(`${JSON.stringify(detect(cwd), null, 2)}\n`);
}
