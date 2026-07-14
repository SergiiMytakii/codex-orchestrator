import type { MissionCapability } from './mission-capability-kernel.js';
import {
  missionScopeRelationshipKinds,
  type MissionScopeExpansionProposal,
} from './mission-scope-expansion.js';

export interface MissionDiagnosisInput {
  missionId: string;
  snapshotId: string;
  findingIds: string[];
  allowedCapabilities: MissionCapability[];
  allowedRunnerActions?: string[];
  repository?: string;
  evidenceIds?: string[];
}

export type MissionAgentProposal =
  | {
      version: 1;
      kind: 'runner-action';
      executorId: string;
      findingIds: string[];
      rationale: string;
    }
  | (MissionScopeExpansionProposal & {
      kind: 'scope-expansion';
      rationale: string;
    })
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
    return parseProposal(raw, input);
  }
}

function parseProposal(raw: string, input: MissionDiagnosisInput): MissionAgentProposal {
  const allowed = new Set(input.allowedCapabilities);
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
  if (record.kind === 'runner-action') {
    assertExact(record, ['version', 'kind', 'executorId', 'findingIds', 'rationale']);
    const executorId = assertText(record.executorId, 'executorId');
    if (!(input.allowedRunnerActions ?? []).includes(executorId)) {
      return invalid('runner action is not allowed for this diagnosis');
    }
    const findingIds = assertTextArray(record.findingIds, 'findingIds');
    if (findingIds.some((id) => !input.findingIds.includes(id))) {
      return invalid('runner action references an unknown finding');
    }
    return {
      version: 1,
      kind: 'runner-action',
      executorId,
      findingIds,
      rationale: assertText(record.rationale, 'rationale'),
    };
  }
  if (record.kind === 'scope-expansion') {
    assertExact(record, [
      'version', 'kind', 'repository', 'paths', 'evidenceIds', 'relationship', 'rationale',
    ]);
    const repository = assertText(record.repository, 'repository');
    if (!input.repository || repository !== input.repository) {
      return invalid('scope expansion repository does not match the pinned repository');
    }
    const evidenceIds = assertTextArray(record.evidenceIds, 'evidenceIds');
    const knownEvidence = new Set([...input.findingIds, ...(input.evidenceIds ?? [])]);
    if (evidenceIds.some((id) => !knownEvidence.has(id))) {
      return invalid('scope expansion references unknown evidence');
    }
    const relationship = parseRelationship(record.relationship);
    return {
      version: 1,
      kind: 'scope-expansion',
      repository,
      paths: assertSafePaths(record.paths),
      evidenceIds,
      relationship,
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
  if (input.allowedCapabilities.length === 0 && (input.allowedRunnerActions?.length ?? 0) === 0) {
    invalid('at least one allowed capability is required');
  }
}

function parseRelationship(value: unknown): MissionScopeExpansionProposal['relationship'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('relationship must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['kind', 'from', 'generatorId']);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || !('kind' in record) || !('from' in record)) {
    return invalid('relationship fields are invalid');
  }
  if (typeof record.kind !== 'string'
    || !missionScopeRelationshipKinds.includes(record.kind as MissionScopeExpansionProposal['relationship']['kind'])) {
    return invalid('relationship kind is invalid');
  }
  const generatorId = record.generatorId === undefined
    ? undefined : assertText(record.generatorId, 'generatorId');
  return {
    kind: record.kind as MissionScopeExpansionProposal['relationship']['kind'],
    from: assertSafePaths([record.from])[0]!,
    ...(generatorId ? { generatorId } : {}),
  };
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
