import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue, GitHubIssueAdapter } from '../github/issues.js';
import { bulletList } from './command-utils.js';

export interface PlanChildNode {
  stableId: string;
  issueNumber?: number;
  title: string;
  body: string;
  afkHitl: 'afk' | 'hitl';
  ownershipScope: string[];
  dependsOn: string[];
  verification: string[];
}

export interface PlanDependencyEdge {
  from: string;
  to: string;
  reason: string;
}

export interface PlanGraph {
  nodes: PlanChildNode[];
  edges: PlanDependencyEdge[];
  specGate: 'wave-level';
}

export type PlanGraphValidationResult = { ok: true } | { ok: false; errors: string[] };

export interface AutonomousChildMetadata {
  stableId: string;
  afkHitl: 'afk' | 'hitl';
  dependsOn: string[];
  ownershipScope: string[];
  verification: string[];
}

export interface AutonomousChildNode {
  issue: GitHubIssue;
  metadata: AutonomousChildMetadata;
}

export type AutonomousChildMetadataParseResult =
  | { ok: true; node: AutonomousChildNode }
  | { ok: false; errors: string[] };

export type AutonomousChildBatchResult =
  | { ok: true; batches: AutonomousChildNode[][] }
  | { ok: false; errors: string[] };

const markerPattern = /^<!-- codex-orchestrator:autonomous-child parent=#\d+ -->$/;

export function renderAutonomousChildMarker(parentIssueNumber: number): string {
  return `<!-- codex-orchestrator:autonomous-child parent=#${parentIssueNumber} -->`;
}

export function ensureAutonomousChildBody(body: string, parentIssueNumber: number): string {
  const marker = renderAutonomousChildMarker(parentIssueNumber);
  const lines = body.split(/\r?\n/).filter((line) => !markerPattern.test(line.trim()));
  return [marker, ...lines].join('\n').trimEnd();
}

export function renderAutonomousChildBody(node: PlanChildNode, parentIssueNumber: number): string {
  const body = stripGeneratedAutonomousChildSections(node.body);
  return ensureAutonomousChildBody(
    [
      body,
      '',
      '## codex-orchestrator metadata',
      `Stable ID: ${node.stableId}`,
      `AFK/HITL: ${node.afkHitl}`,
      `Depends on: ${node.dependsOn.length > 0 ? node.dependsOn.join(', ') : 'none'}`,
      'Ownership:',
      ...bulletList(node.ownershipScope),
      'Spec gate: wave-level',
      'Verification:',
      ...bulletList(node.verification),
    ].join('\n'),
    parentIssueNumber,
  );
}

export function isAutonomousChildOfParent(
  issue: GitHubIssue,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
): boolean {
  const labels = new Set(issue.labels.map((label) => label.name));
  return labels.has(config.github.labels.child.name) && issue.body.includes(renderAutonomousChildMarker(parentIssueNumber));
}

export function validatePlanGraph(graph: PlanGraph): PlanGraphValidationResult {
  const structural = validatePlanGraphStructure(graph);
  if (!structural.ok) {
    return structural;
  }

  const errors: string[] = [];
  const nodesById = new Map(graph.nodes.map((node) => [node.stableId.trim(), node]));
  const dependencies = graphDependencies(graph);
  const waves = computeTopologicalWaves(dependencies);
  if (!waves.ok) {
    errors.push(waves.error);
  } else {
    for (const wave of waves.waves) {
      const seenScopes = new Map<string, string>();
      for (const nodeId of wave) {
        const node = nodesById.get(nodeId);
        if (!node) {
          continue;
        }
        for (const scope of normalizedItems(node.ownershipScope)) {
          const previous = seenScopes.get(scope);
          if (previous) {
            errors.push(`same-wave ownership overlap: ${previous} and ${nodeId} both own ${scope}`);
          } else {
            seenScopes.set(scope, nodeId);
          }
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validatePlanGraphStructure(graph: PlanGraph): PlanGraphValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    errors.push('graph.nodes must contain at least one child node');
  }
  if (!Array.isArray(graph.edges)) {
    errors.push('graph.edges must be an array');
  }
  if (graph.specGate !== 'wave-level') {
    errors.push('graph.specGate must be wave-level');
  }

  const nodesById = new Map<string, PlanChildNode>();
  for (const node of graph.nodes ?? []) {
    const id = node.stableId.trim();
    if (id.length === 0) {
      errors.push('node.stableId must be non-empty');
      continue;
    }
    if (nodesById.has(id)) {
      errors.push(`duplicate node stableId: ${id}`);
    }
    nodesById.set(id, node);
    if (normalizedItems(node.ownershipScope).length === 0) {
      errors.push(`node ${id} must include at least one ownershipScope`);
    }
    if (normalizedItems(node.verification).length === 0) {
      errors.push(`node ${id} must include at least one verification expectation`);
    }
  }

  const dependencies = graphDependencies(graph);

  for (const node of graph.nodes ?? []) {
    const id = node.stableId.trim();
    for (const dependency of node.dependsOn) {
      const dep = dependency.trim();
      if (!nodesById.has(dep)) {
        errors.push(`node ${id} depends on unknown node ${dep}`);
        continue;
      }
      if (dep === id) {
        errors.push(`node ${id} cannot depend on itself`);
        continue;
      }
    }
  }

  for (const edge of graph.edges ?? []) {
    const from = edge.from.trim();
    const to = edge.to.trim();
    if (!nodesById.has(from)) {
      errors.push(`edge references unknown from node ${from}`);
      continue;
    }
    if (!nodesById.has(to)) {
      errors.push(`edge references unknown to node ${to}`);
      continue;
    }
    if (from === to) {
      errors.push(`edge ${from} -> ${to} cannot reference the same node`);
      continue;
    }
  }

  const waves = computeTopologicalWaves(dependencies);
  if (!waves.ok) {
    errors.push(waves.error);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function parseAutonomousChildMetadata(
  issue: GitHubIssue,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
): AutonomousChildMetadataParseResult {
  if (!isAutonomousChildOfParent(issue, config, parentIssueNumber)) {
    return { ok: false, errors: [`Issue #${issue.number} is not an autonomous child of #${parentIssueNumber}`] };
  }

  const metadataLines = readMetadataSection(issue.body);
  if (metadataLines.length === 0) {
    return { ok: false, errors: [`Issue #${issue.number} missing codex-orchestrator metadata section`] };
  }

  const stableId = readSingleValue(metadataLines, 'Stable ID');
  const afkHitl = readSingleValue(metadataLines, 'AFK/HITL');
  const dependsOn = parseDependsOn(readSingleValue(metadataLines, 'Depends on'));
  const ownershipScope = readBulletBlock(metadataLines, 'Ownership');
  const specGate = readSingleValue(metadataLines, 'Spec gate');
  const verification = readBulletBlock(metadataLines, 'Verification');
  const errors: string[] = [];

  if (!stableId) {
    errors.push(`Issue #${issue.number} Stable ID is required`);
  }
  const parsedAfkHitl = afkHitl === 'afk' || afkHitl === 'hitl' ? afkHitl : undefined;
  if (!parsedAfkHitl) {
    errors.push(`Issue #${issue.number} AFK/HITL must be afk or hitl`);
  }
  if (ownershipScope.length === 0) {
    errors.push(`Issue #${issue.number} Ownership must include at least one entry`);
  }
  if (specGate !== 'wave-level') {
    errors.push(`Issue #${issue.number} Spec gate must be wave-level`);
  }
  if (verification.length === 0) {
    errors.push(`Issue #${issue.number} Verification must include at least one entry`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const safeAfkHitl = parsedAfkHitl;
  if (!safeAfkHitl) {
    return { ok: false, errors: [`Issue #${issue.number} AFK/HITL must be afk or hitl`] };
  }

  return {
    ok: true,
    node: {
      issue,
      metadata: {
        stableId,
        afkHitl: safeAfkHitl,
        dependsOn,
        ownershipScope,
        verification,
      },
    },
  };
}

export function collectExecutableChildBatches(
  nodes: AutonomousChildNode[],
  config: CodexOrchestratorConfig,
): AutonomousChildBatchResult {
  const errors: string[] = [];
  const manualLabel = config.github.labels.manual.name;
  const blockedLabel = config.github.labels.blocked.name;
  const runningLabel = config.github.labels.running.name;
  const reviewLabel = config.github.labels.review.name;
  const nodesById = new Map<string, AutonomousChildNode>();

  for (const node of nodes) {
    const id = node.metadata.stableId.trim();
    if (nodesById.has(id)) {
      errors.push(`duplicate child stableId: ${id}`);
    }
    nodesById.set(id, node);
    const labels = new Set(node.issue.labels.map((label) => label.name));
    if (node.issue.state === 'CLOSED') {
      errors.push(`Issue #${node.issue.number} is closed`);
    }
    if (node.metadata.afkHitl !== 'afk') {
      errors.push(`Issue #${node.issue.number} is ${node.metadata.afkHitl}`);
    }
    for (const [label, reason] of [
      [manualLabel, 'manual'],
      [blockedLabel, 'blocked'],
      [runningLabel, 'running'],
      [reviewLabel, 'review'],
    ] as const) {
      if (labels.has(label)) {
        errors.push(`Issue #${node.issue.number} is ${reason}`);
      }
    }
  }

  const graph = graphFromAutonomousNodes(nodes);
  const validation = validatePlanGraphStructure(graph);
  if (!validation.ok) {
    errors.push(...validation.errors);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const batches = scheduleExecutableBatches(nodes, Math.min(config.runner.maxParallelChildren, 3));
  return { ok: true, batches };
}

export function topologicalPlanNodes(graph: PlanGraph): PlanChildNode[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.stableId, node]));
  const dependencies = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    dependencies.set(node.stableId, new Set(node.dependsOn));
  }
  for (const edge of graph.edges) {
    dependencies.get(edge.to)?.add(edge.from);
  }
  const waves = computeTopologicalWaves(dependencies);
  if (!waves.ok) {
    return graph.nodes;
  }
  return waves.waves.flatMap((wave) => wave.flatMap((id) => {
    const node = nodesById.get(id);
    return node ? [node] : [];
  }));
}

export async function persistAutonomousChildNode(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
  node: PlanChildNode,
): Promise<GitHubIssue> {
  const body = renderAutonomousChildBody(node, parentIssueNumber);
  const childLabel = config.github.labels.child.name;

  let issue: GitHubIssue;
  if (node.issueNumber !== undefined) {
    const existing = await issueAdapter.getIssue(node.issueNumber);
    if (!existing) {
      throw new Error(`Existing issue #${node.issueNumber} was not found`);
    }
    if (!isAutonomousChildOfParent(existing, config, parentIssueNumber)) {
      throw new Error(
        `Existing issue #${node.issueNumber} is not an autonomous child of #${parentIssueNumber}; refusing to update arbitrary issue.`,
      );
    }
    issue = await issueAdapter.updateIssue(node.issueNumber, {
      title: node.title,
      body,
      addLabels: [childLabel],
    });
  } else {
    issue = await issueAdapter.createIssue({
      title: node.title,
      body,
      labels: [childLabel],
    });
  }

  if (!isAutonomousChildOfParent(issue, config, parentIssueNumber)) {
    throw new Error(`Child issue #${issue.number} was not persisted with the autonomous marker for #${parentIssueNumber}.`);
  }
  return issue;
}

export async function readAutonomousChildNodes(
  issueAdapter: GitHubIssueAdapter,
  config: CodexOrchestratorConfig,
  parentIssueNumber: number,
  childIssues: GitHubIssue[],
): Promise<AutonomousChildNode[]> {
  const nodes: AutonomousChildNode[] = [];
  const errors: string[] = [];
  for (const child of childIssues) {
    const current = await issueAdapter.getIssue(child.number);
    if (!current) {
      errors.push(`Child issue #${child.number} was not found during execution readback`);
      continue;
    }
    const parsed = parseAutonomousChildMetadata(current, config, parentIssueNumber);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }
    nodes.push(parsed.node);
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return nodes;
}

function computeTopologicalWaves(
  dependencies: Map<string, Set<string>>,
): { ok: true; waves: string[][] } | { ok: false; error: string } {
  const remaining = new Map(Array.from(dependencies, ([id, deps]) => [id, new Set(deps)]));
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const ready = Array.from(remaining)
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) {
      return { ok: false, error: 'graph contains a dependency cycle' };
    }
    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
    }
    for (const deps of remaining.values()) {
      for (const id of ready) {
        deps.delete(id);
      }
    }
  }

  return { ok: true, waves };
}

function graphDependencies(graph: PlanGraph): Map<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>();
  const nodeIds = new Set((graph.nodes ?? []).map((node) => node.stableId.trim()).filter(Boolean));
  for (const id of nodeIds) {
    dependencies.set(id, new Set());
  }
  for (const node of graph.nodes ?? []) {
    const id = node.stableId.trim();
    const deps = dependencies.get(id);
    if (!deps) {
      continue;
    }
    for (const dependency of node.dependsOn) {
      const dep = dependency.trim();
      if (nodeIds.has(dep) && dep !== id) {
        deps.add(dep);
      }
    }
  }
  for (const edge of graph.edges ?? []) {
    const from = edge.from.trim();
    const to = edge.to.trim();
    if (nodeIds.has(from) && nodeIds.has(to) && from !== to) {
      dependencies.get(to)?.add(from);
    }
  }
  return dependencies;
}

function graphFromAutonomousNodes(nodes: AutonomousChildNode[]): PlanGraph {
  return {
    nodes: nodes.map((node) => ({
      stableId: node.metadata.stableId,
      title: node.issue.title,
      body: node.issue.body,
      afkHitl: node.metadata.afkHitl,
      ownershipScope: node.metadata.ownershipScope,
      dependsOn: node.metadata.dependsOn,
      verification: node.metadata.verification,
    })),
    edges: [],
    specGate: 'wave-level',
  };
}

function scheduleExecutableBatches(nodes: AutonomousChildNode[], limit: number): AutonomousChildNode[][] {
  const remaining = new Map(nodes.map((node) => [node.metadata.stableId, node]));
  const completed = new Set<string>();
  const batches: AutonomousChildNode[][] = [];

  while (remaining.size > 0) {
    const ready = Array.from(remaining.values())
      .filter((node) => node.metadata.dependsOn.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.issue.number - right.issue.number);
    const batch: AutonomousChildNode[] = [];
    const scopes = new Set<string>();

    for (const node of ready) {
      if (batch.length >= limit) {
        break;
      }
      const nodeScopes = normalizedItems(node.metadata.ownershipScope);
      if (nodeScopes.some((scope) => scopes.has(scope))) {
        continue;
      }
      batch.push(node);
      for (const scope of nodeScopes) {
        scopes.add(scope);
      }
    }

    if (batch.length === 0 && ready[0]) {
      batch.push(ready[0]);
    }
    for (const node of batch) {
      remaining.delete(node.metadata.stableId);
      completed.add(node.metadata.stableId);
    }
    batches.push(batch);
  }

  return batches;
}

function readMetadataSection(body: string): string[] {
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.trim() === '## codex-orchestrator metadata') {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return [];
  }
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) {
      break;
    }
    section.push(line);
  }
  return section;
}

function stripGeneratedAutonomousChildSections(body: string): string {
  const removedHeadings = new Set(['## Blocked by', '## codex-orchestrator metadata']);
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      skipping = removedHeadings.has(trimmed);
      if (skipping) {
        continue;
      }
    }
    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join('\n').trimEnd();
}

function readSingleValue(lines: string[], key: string): string {
  const prefix = `${key}:`;
  const line = lines.find((item) => item.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : '';
}

function readBulletBlock(lines: string[], key: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) {
    return [];
  }
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^[A-Za-z][A-Za-z /-]*:/.test(trimmed)) {
      break;
    }
    if (trimmed.startsWith('- ')) {
      values.push(trimmed.slice(2).trim());
    }
  }
  return normalizedItems(values);
}

function parseDependsOn(value: string): string[] {
  if (!value || value === 'none') {
    return [];
  }
  return normalizedItems(value.split(','));
}

function normalizedItems(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}
