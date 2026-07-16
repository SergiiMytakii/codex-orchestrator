#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { resolve, basename, dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function runGit(cwd, args) {
  const env = { ...process.env };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return { code: result.status ?? 1, out: (result.stdout ?? '').replace(/[\r\n]+$/u, ''), error: (result.stderr ?? '').trim() };
}

function lines(value) { return value.split(/\r?\n/u).filter((line) => line.trim()); }

export function collect(cwdInput, relatedLimit = 25) {
  const cwd = resolve(cwdInput);
  const rootResult = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (rootResult.code !== 0 || !rootResult.out) return { ok: false, cwd, is_git_repo: false, error: 'not a git repository' };
  const root = rootResult.out;
  let branchResult = runGit(root, ['branch', '--show-current']);
  if (branchResult.code !== 0 || !branchResult.out) branchResult = runGit(root, ['rev-parse', '--short', 'HEAD']);
  const status = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.code !== 0) return { ok: false, cwd, repo_root: root, is_git_repo: true, error: `git status failed: ${status.error}` };
  const statusShort = lines(status.out);
  const buckets = { staged: [], unstaged: [], untracked: [] };
  for (const line of statusShort) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    if (line.startsWith('?? ')) buckets.untracked.push(path);
    else { if (line[0] !== ' ') buckets.staged.push(path); if (line[1] !== ' ') buckets.unstaged.push(path); }
  }
  const commands = [['diff', '--name-only'], ['diff', '--cached', '--name-only'], ['ls-files', '--others', '--exclude-standard']];
  const commandResults = commands.map((args) => ({ args, result: runGit(root, args) }));
  const failedCommand = commandResults.find(({ result }) => result.code !== 0);
  if (failedCommand) return { ok: false, cwd, repo_root: root, is_git_repo: true, error: `git ${failedCommand.args.join(' ')} failed: ${failedCommand.result.error}` };
  const changed = [...new Set(commandResults.flatMap(({ result }) => lines(result.out)))].sort();
  const stems = new Set(changed.map((item) => basename(item).replace(/\.[^.]+$/u, '')).filter(Boolean));
  const candidates = new Set();
  for (const item of changed) {
    const directory = join(root, dirname(item));
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = relative(root, join(directory, entry.name)).split('\\').join('/');
      if (/test|spec|\.mdx?$/iu.test(rel)) candidates.add(rel);
    }
  }
  for (const marker of ['tests', 'test', '__tests__', 'docs']) {
    const directory = join(root, marker);
    if (!existsSync(directory)) continue;
    const queue = [directory];
    while (queue.length > 0 && candidates.size < relatedLimit) {
      const current = queue.shift();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile()) {
          const rel = relative(root, path).split('\\').join('/');
          if (stems.size === 0 || [...stems].some((stem) => rel.toLowerCase().includes(stem.toLowerCase()))) candidates.add(rel);
        }
      }
    }
  }
  const diff = runGit(root, ['diff', '--stat']);
  const cached = runGit(root, ['diff', '--cached', '--stat']);
  const recent = runGit(root, ['log', '--oneline', '-5']);
  for (const [name, result] of [['diff --stat', diff], ['diff --cached --stat', cached], ['log --oneline -5', recent]]) {
    if (result.code !== 0) return { ok: false, cwd, repo_root: root, is_git_repo: true, error: `git ${name} failed: ${result.error}` };
  }
  return {
    ok: true, cwd, repo_root: root, is_git_repo: true, branch: branchResult.out,
    status_summary: { total_lines: statusShort.length, staged: buckets.staged.length, unstaged: buckets.unstaged.length, untracked: buckets.untracked.length },
    status_short: statusShort, staged_files: buckets.staged, unstaged_files: buckets.unstaged, untracked_files: buckets.untracked,
    diff_stat: diff.out, cached_diff_stat: cached.out, changed_files: changed, recent_commits: lines(recent.out),
    nearby_tests_or_docs: [...candidates].sort().slice(0, relatedLimit),
    safety: { read_only: true, tests_executed: false, files_modified: false, env_files_read: false },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwdIndex = process.argv.indexOf('--cwd');
  const limitIndex = process.argv.indexOf('--related-limit');
  const cwd = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : '.';
  const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : 25;
  if (!cwd || !Number.isInteger(limit)) { process.stderr.write('invalid arguments\n'); process.exitCode = 2; }
  else process.stdout.write(`${JSON.stringify(collect(cwd, limit), null, 2)}\n`);
}
