import { globMatches, normalizePath, uniqueSortedPaths } from '../path-policy.js';
import { missionPathDenied } from './mission-path-language.js';

export const missionScopeRelationshipKinds = [
  'imports',
  'imported-by',
  'test-for',
  'implementation-for',
  'config-consumer',
  'generated-from',
  'acceptance-artifact-owner',
] as const;

export type MissionScopeRelationshipKind = (typeof missionScopeRelationshipKinds)[number];

export interface MissionScopeRelationship {
  kind: MissionScopeRelationshipKind;
  from: string;
  to: string;
  evidenceId: string;
  generatorId?: string;
}

export interface MissionScopeExpansionProposal {
  version: 1;
  repository: string;
  paths: string[];
  evidenceIds: string[];
  relationship: {
    kind: MissionScopeRelationshipKind;
    from: string;
    generatorId?: string;
  };
}

export interface MissionScopeExpansionContext {
  repository: string;
  repositoryPaths: string[];
  grantedPaths: string[];
  evidenceIds: string[];
  relationships: MissionScopeRelationship[];
  allowlistedGeneratorIds: string[];
  deniedPaths: string[];
  maxExpandedPaths: number;
}

export type MissionScopeExpansionDecision =
  | {
      kind: 'allowed';
      repository: string;
      paths: string[];
      relationship: MissionScopeRelationshipKind;
      evidenceIds: string[];
    }
  | {
      kind: 'rejected-recoverable';
      reason: string;
      alternatives: string[];
    }
  | {
      kind: 'safety-stop';
      reason: string;
      evidence: string[];
    };

export function authorizeMissionScopeExpansion(
  context: MissionScopeExpansionContext,
  proposal: MissionScopeExpansionProposal,
): MissionScopeExpansionDecision {
  assertContext(context);
  if (proposal.version !== 1) {
    return rejected('unsupported-proposal-version', ['submit a version 1 scope proposal']);
  }
  const expectedRepository = normalizeRepository(context.repository);
  const receivedRepository = normalizeRepository(proposal.repository);
  if (receivedRepository !== expectedRepository) {
    return {
      kind: 'safety-stop',
      reason: 'repository-identity-mismatch',
      evidence: [`expected:${expectedRepository}`, `received:${receivedRepository}`],
    };
  }
  const evidenceIds = uniqueText(proposal.evidenceIds);
  if (evidenceIds.length === 0 || evidenceIds.some((id) => !context.evidenceIds.includes(id))) {
    return rejected('evidence-not-pinned', ['collect evidence from the pinned Mission snapshot']);
  }
  const source = normalizeConcretePath(proposal.relationship.from);
  if (!context.grantedPaths.some((grant) => globMatches(grant, source))) {
    return rejected('relationship-source-outside-current-scope', [
      'anchor the relationship in an already granted path',
    ]);
  }
  if (!context.repositoryPaths.map(normalizeConcretePath).includes(source)) {
    return rejected('relationship-source-not-in-pinned-tree', [
      'anchor the relationship in a path from the pinned tree',
    ]);
  }
  const expanded = expandFinitePaths(proposal.paths, context.repositoryPaths);
  if (expanded.length === 0) {
    return rejected('scope-pattern-matched-no-pinned-paths', [
      'request an exact path present in the pinned tree',
    ]);
  }
  if (expanded.length > context.maxExpandedPaths) {
    return rejected('scope-expansion-limit-exceeded', [
      `request at most ${context.maxExpandedPaths} related paths`,
    ]);
  }
  const denied = expanded.filter((path) => missionPathDenied(path, context.deniedPaths));
  if (denied.length > 0) {
    return {
      kind: 'safety-stop',
      reason: 'scope-expansion-denied-path',
      evidence: denied,
    };
  }
  if (proposal.relationship.kind === 'generated-from') {
    const generatorId = proposal.relationship.generatorId?.trim();
    if (!generatorId || !context.allowlistedGeneratorIds.includes(generatorId)) {
      return rejected('generator-not-allowlisted', [
        'use an allowlisted deterministic generator',
        'choose a non-generated related path',
      ]);
    }
  }
  const relationships = expanded.map((target) => context.relationships.find((relationship) =>
    relationship.kind === proposal.relationship.kind
    && normalizeConcretePath(relationship.from) === source
    && normalizeConcretePath(relationship.to) === target
    && evidenceIds.includes(relationship.evidenceId)
    && (relationship.kind !== 'generated-from'
      || relationship.generatorId === proposal.relationship.generatorId)));
  if (relationships.some((relationship) => relationship === undefined)) {
    const knownKinds = uniqueText(context.relationships
      .filter((relationship) => normalizeConcretePath(relationship.from) === source)
      .map((relationship) => relationship.kind));
    return rejected('relationship-not-proven', [
      ...knownKinds.map((kind) => `request a path linked by ${kind}`),
      'collect new pinned relationship evidence',
    ]);
  }
  return {
    kind: 'allowed',
    repository: expectedRepository,
    paths: expanded,
    relationship: proposal.relationship.kind,
    evidenceIds,
  };
}

function expandFinitePaths(patterns: string[], repositoryPaths: string[]): string[] {
  const normalizedPatterns = uniqueText(patterns.map(normalizePattern));
  const normalizedPaths = uniqueSortedPaths(repositoryPaths.map(normalizeConcretePath));
  return normalizedPaths.filter((path) => normalizedPatterns.some((pattern) => globMatches(pattern, path)));
}

function normalizeRepository(value: string): string {
  const normalized = value.trim().normalize('NFC');
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized)) {
    throw new Error('Mission scope repository must be owner/name.');
  }
  return normalized;
}

function normalizePattern(value: string): string {
  const normalized = normalizePath(value).normalize('NFC');
  if (normalized.length === 0 || normalized.startsWith('/')
    || normalized.split('/').some((segment) => segment.length === 0 || segment === '..')) {
    throw new Error('Mission scope path must be repository-relative.');
  }
  return normalized;
}

function normalizeConcretePath(value: string): string {
  const normalized = normalizePattern(value);
  if (normalized.includes('*')) {
    throw new Error('Mission scope relationship paths must be concrete.');
  }
  return normalized;
}

function rejected(reason: string, alternatives: string[]): MissionScopeExpansionDecision {
  return {
    kind: 'rejected-recoverable',
    reason,
    alternatives: uniqueInOrder(alternatives),
  };
}

function uniqueText(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function uniqueInOrder(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function assertContext(context: MissionScopeExpansionContext): void {
  normalizeRepository(context.repository);
  if (!Number.isSafeInteger(context.maxExpandedPaths) || context.maxExpandedPaths <= 0) {
    throw new Error('Mission scope maxExpandedPaths must be a positive integer.');
  }
  context.repositoryPaths.forEach(normalizeConcretePath);
  context.relationships.forEach((relationship) => {
    normalizeConcretePath(relationship.from);
    normalizeConcretePath(relationship.to);
    if (!missionScopeRelationshipKinds.includes(relationship.kind)
      || relationship.evidenceId.trim().length === 0) {
      throw new Error('Mission scope relationship is invalid.');
    }
  });
}
