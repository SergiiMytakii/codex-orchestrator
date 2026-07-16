import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const magic = Buffer.from('codex-orchestrator-tool-catalog-v1\0');
export interface ToolCatalogFixtureV1 { version: 1; cliVersion: string; catalogHash: string; entryHashes: Record<string, string>; variants: Record<'read-only' | 'workspace-write', unknown[]> }

export interface CanonicalToolCatalogEntry {
  type: string;
  name: string;
  description: string | null;
  parameters: unknown;
  strict: boolean | null;
}

export function projectToolCatalogEntry(entry: any): CanonicalToolCatalogEntry {
  if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string' || typeof entry.name !== 'string') {
    throw new Error('orchestrator-tool-catalog-entry-invalid');
  }
  if (entry.type === 'namespace') {
    return { type: entry.type, name: entry.name, description: entry.description ?? null, parameters: null, strict: null };
  }
  return {
    type: entry.type,
    name: entry.name,
    description: entry.description ?? null,
    parameters: entry.parameters ?? null,
    strict: typeof entry.strict === 'boolean' ? entry.strict : null,
  };
}

export async function loadToolCatalogFixture(path: string): Promise<ToolCatalogFixtureV1> {
  const fixture = JSON.parse(await readFile(path, 'utf8')) as ToolCatalogFixtureV1;
  if (fixture.version !== 1 || fixture.cliVersion !== '0.144.4') throw new Error('orchestrator-tool-catalog-fixture-invalid');
  for (const variant of ['read-only', 'workspace-write'] as const) {
    const entries = fixture.variants[variant];
    if (!Array.isArray(entries) || entries.length !== 6) throw new Error('orchestrator-tool-catalog-fixture-invalid');
    for (const entry of entries as any[]) {
      const key = `${entry.type}:${entry.name}`;
      if (sha(Buffer.from(canonical(entry))) !== fixture.entryHashes[key]) throw new Error(`orchestrator-tool-catalog-entry-mismatch:${key}`);
    }
    const hash = createHash('sha256').update(magic);
    for (const entry of [...entries as any[]].sort((a, b) => compare(`${a.type}\0${a.name}`, `${b.type}\0${b.name}`))) {
      const bytes = Buffer.from(canonical(entry)); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
      hash.update(length).update(bytes);
    }
    if (hash.digest('hex') !== fixture.catalogHash) throw new Error('orchestrator-tool-catalog-hash-mismatch');
  }
  return fixture;
}

export function canonical(value: any): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function sha(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function compare(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
