import type { MissionCapability } from './mission-capability-kernel.js';

export interface MissionDiagnosisInput {
  missionId: string;
  snapshotId: string;
  findingIds: string[];
  allowedCapabilities: MissionCapability[];
}

export type MissionAgentProposal =
  | {
      version: 1;
      kind: 'observe';
      capability: 'read-file' | 'git-status';
      paths: string[];
      rationale: string;
    }
  | {
      version: 1;
      kind: 'patch';
      capability: 'validate-patch';
      paths: string[];
      patch: string;
      rationale: string;
    }
  | {
      version: 1;
      kind: 'external-input';
      evidence: string[];
      resumePredicate: string;
    }
  | {
      version: 1;
      kind: 'safety-stop';
      evidence: string[];
      invariant: string;
    };

export interface MissionModelTransport {
  diagnose(input: Readonly<MissionDiagnosisInput>): Promise<string>;
}

export class MissionAgentBroker {
  public constructor(private readonly transport: MissionModelTransport) {}

  public async diagnose(input: MissionDiagnosisInput): Promise<MissionAgentProposal> {
    assertDiagnosisInput(input);
    const raw = await this.transport.diagnose(structuredClone(input));
    return parseProposal(raw, new Set(input.allowedCapabilities));
  }
}

function parseProposal(raw: string, allowed: ReadonlySet<MissionCapability>): MissionAgentProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('expected JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('root must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || typeof record.kind !== 'string') {
    return invalid('version and kind are required');
  }
  if (record.kind === 'observe') {
    assertExact(record, ['version', 'kind', 'capability', 'paths', 'rationale']);
    if (record.capability !== 'read-file' && record.capability !== 'git-status') {
      return invalid('unknown observation capability');
    }
    if (!allowed.has(record.capability)) {
      return invalid('capability is not allowed for this diagnosis');
    }
    return {
      version: 1,
      kind: 'observe',
      capability: record.capability,
      paths: assertSafePaths(record.paths),
      rationale: assertText(record.rationale, 'rationale'),
    };
  }
  if (record.kind === 'patch') {
    assertExact(record, ['version', 'kind', 'capability', 'paths', 'patch', 'rationale']);
    if (record.capability !== 'validate-patch' || !allowed.has('validate-patch')) {
      return invalid('patch capability is not allowed');
    }
    return {
      version: 1,
      kind: 'patch',
      capability: 'validate-patch',
      paths: assertSafePaths(record.paths),
      patch: assertText(record.patch, 'patch'),
      rationale: assertText(record.rationale, 'rationale'),
    };
  }
  if (record.kind === 'external-input') {
    assertExact(record, ['version', 'kind', 'evidence', 'resumePredicate']);
    return {
      version: 1,
      kind: 'external-input',
      evidence: assertTextArray(record.evidence, 'evidence'),
      resumePredicate: assertText(record.resumePredicate, 'resumePredicate'),
    };
  }
  if (record.kind === 'safety-stop') {
    assertExact(record, ['version', 'kind', 'evidence', 'invariant']);
    return {
      version: 1,
      kind: 'safety-stop',
      evidence: assertTextArray(record.evidence, 'evidence'),
      invariant: assertText(record.invariant, 'invariant'),
    };
  }
  return invalid('unknown kind');
}

function assertDiagnosisInput(input: MissionDiagnosisInput): void {
  assertText(input.missionId, 'missionId');
  assertText(input.snapshotId, 'snapshotId');
  assertTextArray(input.findingIds, 'findingIds');
  if (input.allowedCapabilities.length === 0) {
    invalid('at least one allowed capability is required');
  }
}

function assertSafePaths(value: unknown): string[] {
  const paths = assertTextArray(value, 'paths');
  if (paths.some((path) => path.startsWith('/') || path.split('/').includes('..')
    || /(^|\/)\.env(?:\.|$)/iu.test(path) || path === '.git' || path.startsWith('.git/'))) {
    return invalid('paths contain a secret, Git internal, absolute, or traversal path');
  }
  return paths;
}

function assertExact(record: Record<string, unknown>, fields: string[]): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected || fields.some((field) => !(field in record))) {
    invalid(unexpected ? `unexpected field ${unexpected}` : 'required field is missing');
  }
}

function assertText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid(`${field} must be non-empty`);
  }
  return value;
}

function assertTextArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    return invalid(`${field} must be a non-empty string array`);
  }
  return [...value] as string[];
}

function invalid(reason: string): never {
  throw new Error(`Invalid Mission Agent proposal: ${reason}.`);
}
