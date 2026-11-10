import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Built-in selectors treat conventional Markdown docs as prose. Projects with tested docs supply their own selector. */
export function isDocumentationPath(file: string): boolean {
  return /^(?:docs\/.+\.md|(?:README|CHANGELOG|CONTRIBUTING)\.md)$/iu.test(file);
}

export interface RelatedResources {
  imageRoot?: string;
  publicRoot?: string;
  catalogRoot?: string;
}

const imageExtension = /\.(?:png|jpe?g|webp|gif|svg|avif|ico|bmp)$/iu;
const inside = (file: string, directory?: string) => !!directory && file.startsWith(directory + '/');
const quoted = (value: string) => new RegExp("(['\"\x60])" + escapeRegex(value) + "\\1", 'u');

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function catalog(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('Expected a flat string catalog.');
  return parsed as Record<string, string>;
}

function catalogKeys(root: string, file: string, previous: string | undefined): string[] {
  const before = previous === undefined ? {} : catalog(previous);
  const after = existsSync(join(root, file)) ? catalog(readCandidateFile(root, file)) : {};
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !Object.hasOwn(before, key) || !Object.hasOwn(after, key) || before[key] !== after[key]);
}

function readCandidateFile(root: string, file: string): string {
  const path = join(root, file);
  if (realpathSync(path) !== path) throw new Error(`Cannot read resource dependency through a symlink: ${file}.`);
  return readFileSync(path, 'utf8');
}

/** Expand declared resource changes to current source/test files with literal dependencies. */
export async function expandRelatedResources(input: {
  root: string;
  changed: string[];
  paths: string[];
  rules: RelatedResources;
  language: 'dart' | 'jest';
  readBaseCatalog?: (file: string) => Promise<string | undefined>;
}): Promise<{ paths: string[]; resources: Map<string, Set<string>> }> {
  const root = realpathSync(input.root);
  const available = new Set(input.paths);
  const seeds = new Set<string>();
  const resources = new Map<string, Set<string>>();
  const lookups: Array<{ file: string; pattern: RegExp; key?: string; call?: RegExp }> = [];
  const source = input.language === 'dart' ? /^(?:lib|test)\/.*\.dart$/u : /\.(?:[cm]?[jt]s|[jt]sx|css)$/u;
  for (const file of input.changed) {
    if (input.language === 'dart' && inside(file, input.rules.catalogRoot) && file.endsWith('.json')) {
      if (!input.readBaseCatalog) throw new Error('Catalog selection requires the pinned base reader.');
      const previous = await input.readBaseCatalog(file);
      const keys = catalogKeys(root, file, previous);
      for (const key of keys) lookups.push({ file, pattern: quoted(key), key,
        call: new RegExp('\\btranslate\\s*\\(\\s*' + quoted(key).source, 'u'),
      });
    } else if (imageExtension.test(file) && (inside(file, input.rules.imageRoot) || inside(file, input.rules.publicRoot))) {
      const ref = inside(file, input.rules.publicRoot) ? file.slice(input.rules.publicRoot!.length) : file;
      const url = `url\\(\\s*['"]?${escapeRegex(ref)}['"]?\\s*\\)`;
      lookups.push({ file, pattern: new RegExp(`${quoted(ref).source}|${url}`, 'u') });
    } else {
      seeds.add(file);
    }
  }
  if (!lookups.length) return { paths: [...seeds], resources };
  const matched = new Set<number>();
  for (const file of available) {
    if (!source.test(file)) continue;
    let text: string;
    try { text = readCandidateFile(root, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const catalogPrefixes = input.language === 'dart' && file.startsWith('test/')
      ? [...text.matchAll(/\.startsWith\(\s*(['"])([\w.-]+\.)\1\s*\)/gu)].map(match => match[2]!)
      : [];
    for (const [index, lookup] of lookups.entries()) {
      const readsCatalog = lookup.key !== undefined && file.startsWith('test/') && quoted(lookup.file).test(text);
      const dependsOnResource = lookup.key === undefined ? lookup.pattern.test(text)
        : lookup.call!.test(text)
          || (lookup.key.includes('.') && /\btranslate\s*\(/u.test(text) && lookup.pattern.test(text))
          || (readsCatalog && (lookup.pattern.test(text) || catalogPrefixes.some(prefix => lookup.key!.startsWith(prefix))));
      if (dependsOnResource) {
        if (input.language === 'jest' && file.endsWith('.css'))
          throw new Error(`Configure a project selector for the stylesheet dependency of ${lookup.file}.`);
        matched.add(index);
        seeds.add(file);
        const dependencies = resources.get(lookup.file) ?? new Set<string>();
        dependencies.add(file);
        resources.set(lookup.file, dependencies);
      }
    }
  }
  for (const [index, lookup] of lookups.entries()) {
    if (!matched.has(index)) throw new Error(`No literal test dependency found for ${lookup.file}.`);
  }
  return { paths: [...seeds].sort(), resources };
}
