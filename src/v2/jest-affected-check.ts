import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import JSON5 from 'json5';

// Private host-check executable, launched only with Runner-constructed arguments.
// Its config probe and test command inherit the same owned process group.
const input = JSON.parse(process.argv[2]!) as {
  args: string[]; projectRoot: string; jestArgs: string[]; files: string[];
};
let scoped = false;
const npmSeparator = input.args.includes('--') ? [] : ['--'];
try {
  if (hasStaticConfig()) {
    // Match npm's script PATH, including ancestor dependencies in isolated
    // worktrees. The caller has already excluded lifecycle hooks and wrappers.
    const probe = spawnSync('npm', [...input.args, ...npmSeparator, '--showConfig'], {
      encoding: 'utf8', maxBuffer: 5 * 1024 * 1024,
    });
    if (probe.status === 0) {
      const config = JSON.parse(probe.stdout.slice(probe.stdout.indexOf('{'))) as {
        configs: Array<Record<string, unknown>>; globalConfig: Record<string, unknown>;
      };
      scoped = Array.isArray(config.configs) && config.configs.length > 0 && !!config.globalConfig
        && config.configs.every(project => !hasLocalGlobalModule(project))
        && !hasLocalGlobalModule(config.globalConfig);
    }
  }
} catch { /* Unknown config cannot authorize a narrower check. */ }

const args = scoped ? [...input.args, ...npmSeparator,
  '--passWithNoTests=false', '--findRelatedTests', ...input.files] : input.args;
console.log(`[Runner ${scoped ? 'affected Jest' : 'full configured'} check: ${JSON.stringify(args)}]`);
const result = spawnSync('npm', args, { stdio: 'inherit' });
process.exitCode = result.status ?? 127;

function hasLocalGlobalModule(config: Record<string, unknown>): boolean {
  // Native related-test selection does not add edges from global Jest hooks to
  // every suite. Decline narrowing for local hooks, including their dependencies.
  const localFile = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(localFile);
    if (value && typeof value === 'object') return Object.values(value).some(localFile);
    return typeof value === 'string' && isAbsolute(value) && !value.includes('/node_modules/')
      && existsSync(value) && lstatSync(value).isFile();
  };
  // Mapped imports are already edges in Jest's native resolver; other local
  // configuration modules (including serializers and custom future hooks) are global.
  return Object.entries(config).some(([key, value]) => key !== 'moduleNameMapper' && localFile(value));
}

function hasStaticConfig(): boolean {
  let explicit: string | undefined;
  for (let index = 0; index < input.jestArgs.length; index += 1) {
    const arg = input.jestArgs[index]!;
    if (arg === '--config') explicit = input.jestArgs[++index];
    else if (arg.startsWith('--config=')) explicit = arg.slice('--config='.length);
  }
  const packageJson = JSON.parse(readFileSync(join(input.projectRoot, 'package.json'), 'utf8')) as { jest?: unknown };
  const files = explicit ? [resolve(input.projectRoot, explicit)] : [
    'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.cts', 'jest.config.json',
  ].map(file => join(input.projectRoot, file)).filter(file => existsSync(file));
  let config: unknown;
  if (!explicit && files.length === 0) config = packageJson.jest;
  else {
    if (files.length !== 1 || (!explicit && packageJson.jest !== undefined)) return false;
    const file = files[0]!;
    if (relative(input.projectRoot, file).startsWith('..') || basename(file).startsWith('.env')) return false;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return false;
    const source = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) config = JSON5.parse(source);
    else {
      const body = source.replace(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u, '');
      const literal = /^(?:module\.exports\s*=|export\s+default)\s*([\s\S]*?)\s*;?\s*$/u.exec(body);
      if (!literal) return false;
      // Parse object literals as data. Never evaluate config imports, functions
      // or environment branches: their dependencies escape ordinary test imports.
      config = JSON5.parse(literal[1]!);
    }
  }
  return !!config && typeof config === 'object' && !Array.isArray(config)
    && !('preset' in config) && !('projects' in config);
}
