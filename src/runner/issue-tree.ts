import type { CodexOrchestratorConfig } from '../config/schema.js';
import type { GitHubIssue } from '../github/issues.js';

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

const markerPattern = /^<!-- codex-orchestrator:autonomous-child parent=#\d+ -->$/;

export function renderAutonomousChildMarker(parentIssueNumber: number): string {
  return `<!-- codex-orchestrator:autonomous-child parent=#${parentIssueNumber} -->`;
}

export function ensureAutonomousChildBody(body: string, parentIssueNumber: number): string {
  const marker = renderAutonomousChildMarker(parentIssueNumber);
  const lines = body.split(/\r?\n/).filter((line) => !markerPattern.test(line.trim()));
  return [marker, ...lines].join('\n').trimEnd();
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
    if (node.ownershipScope.map((item) => item.trim()).filter(Boolean).length === 0) {
      errors.push(`node ${id} must include at least one ownershipScope`);
    }
    if (node.verification.map((item) => item.trim()).filter(Boolean).length === 0) {
      errors.push(`node ${id} must include at least one verification expectation`);
    }
  }

  const dependencies = new Map<string, Set<string>>();
  for (const id of nodesById.keys()) {
    dependencies.set(id, new Set());
  }

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
      dependencies.get(id)?.add(dep);
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
    dependencies.get(to)?.add(from);
  }

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
        for (const scope of node.ownershipScope.map((item) => item.trim()).filter(Boolean)) {
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
