import type {
  ReviewProfile,
  RuntimeExecutionPolicyV1,
  RuntimeGraphNodeV1,
  RuntimeNodeOutcomeV1,
  RuntimeSkillBundleManifestV1,
} from './package-skill-bundle.js';
import type { TargetExecutionPolicyV2 } from '../config/schema.js';

export interface NodeControlEnvelopeV1 {
  version: 1;
  nodeId: string;
  outcome: RuntimeNodeOutcomeV1;
  artifactRefs: string[];
  result: unknown;
}

export function parseNodeControlEnvelope(value: unknown): NodeControlEnvelopeV1 {
  assertEnvelope(value);
  return value;
}

export interface NodeExecutionOverridesV2 {
  model: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  timeoutMs: number;
  idleTimeoutMs: number;
}

export interface WorktreeBaselineV2 {
  headSha: string;
  indexTreeSha: string;
  statusSha256: string;
  contentSha256: string;
  ownershipToken: string;
}

export interface TransportExecutionRecordV2 {
  executionId: string;
  kind: 'initial' | 'clean-retry' | 'partial-continuation';
  status: 'prepared' | 'running' | 'terminal' | 'reconciled' | 'blocked';
  intentPersistedAt: string;
  process?: { pid: number; processGroupId: number; host: string; bootNonce: string; startedAt: string };
  appServer?: { threadId: string; turnId?: string };
  report: { path: string; sha256?: string; atomicWriteComplete: boolean };
  terminal?: {
    kind: 'completed' | 'failed' | 'interrupted' | 'timeout' | 'idle-timeout' | 'protocol-death' | 'blocked';
    acknowledgedAt: string;
    sideEffectsQuiescedAt: string;
    quiescenceProof: 'thread-clean-empty' | 'process-group-absent';
  };
  recovery?: { kind: 'none' | 'clean-retry' | 'partial-continuation' | 'partial-node-mutation'; artifactPath?: string; reason?: string };
}

export interface NodeAttemptRecordV2 {
  attemptId: string;
  nodeId: string;
  ordinal: number;
  status: 'prepared' | 'running' | 'terminal' | 'reconciled' | 'blocked';
  cleanRetriesConsumed: 0 | 1;
  partialContinuationsConsumed: 0 | 1;
  baseline: WorktreeBaselineV2;
  executions: TransportExecutionRecordV2[];
}

export interface GraphProgressRecordV2 {
  graphId: string;
  templateId?: string;
  reviewProfile?: ReviewProfile;
  currentNodeId: string;
  completedNodeIds: string[];
  joinIds: string[];
  artifactRefs: string[];
  reviewBudget: { maximum: number; consumed: number };
  reviewers: Array<{ nodeId: string; reviewerSlot: string; reviewerId: string; threadId: string; mode: 'full' | 'closure'; verdict: 'Approved' | 'Needs Work' | 'Rejected'; findingIds: string[] }>;
  findings: string[];
  aggregateVerdict?: 'Approved' | 'Needs Work' | 'Rejected';
  closureCount: number;
  attempts: NodeAttemptRecordV2[];
}

export interface ExpandedReviewNodeV1 {
  id: string;
  reviewerSlot: string;
  mode: 'full' | 'closure';
  parallelGroup: string | null;
  requires: string[];
}

export interface ReviewNodeResultV1 {
  nodeId: string;
  reviewerId: string;
  threadId: string;
  verdict: 'Approved' | 'Needs Work' | 'Rejected';
  findingIds: string[];
}

export function startOperationGraph(manifest: RuntimeSkillBundleManifestV1, operationId: string): GraphProgressRecordV2 {
  const operation = manifest.operations[operationId];
  if (!operation) throw new Error(`Unknown package operation: ${operationId}.`);
  const graph = manifest.graphs[operation.graph];
  if (!graph || graph.entryNode !== operation.entryNode) throw new Error(`Package operation ${operationId} has an invalid graph entry.`);
  return {
    graphId: graph.id,
    currentNodeId: graph.entryNode,
    completedNodeIds: [],
    joinIds: [],
    artifactRefs: [],
    reviewBudget: { maximum: 0, consumed: 0 },
    reviewers: [],
    findings: [],
    closureCount: 0,
    attempts: [],
  };
}

export function applyNodeControlEnvelope(
  manifest: RuntimeSkillBundleManifestV1,
  progress: GraphProgressRecordV2,
  envelope: NodeControlEnvelopeV1,
): GraphProgressRecordV2 {
  assertEnvelope(envelope);
  if (progress.aggregateVerdict) throw new Error('Package graph is already terminal.');
  if (envelope.nodeId !== progress.currentNodeId) throw new Error(`Control envelope node ${envelope.nodeId} is not the current node ${progress.currentNodeId}.`);
  if (envelope.artifactRefs.length === 0) throw new Error('A node outcome requires at least one artifact reference.');
  const graph = manifest.graphs[progress.graphId];
  const node = graph?.nodes.find((candidate) => candidate.id === progress.currentNodeId);
  if (!graph || !node) throw new Error('Persisted package graph node is unavailable.');
  const successor = node.successors.find((candidate) => candidate.when === envelope.outcome);
  if (!successor && !allowedTerminalOutcomes(node).includes(envelope.outcome)) throw new Error(`Node ${node.id} returned undeclared outcome ${envelope.outcome}.`);
  assertNodeResult(node.id, envelope.outcome, envelope.result);
  if (node.id === 'code-review' && (!progress.templateId || progress.templateId !== 'code-review'
    || !reviewRequirementSatisfied(progress, 'A-full') || !reviewRequirementSatisfied(progress, 'B-full')
    || !reviewRequirementSatisfied(progress, 'A-closure') || !reviewRequirementSatisfied(progress, 'B-closure')
    || !reviewRequirementSatisfied(progress, 'C-full'))) {
    throw new Error('Code review aggregate cannot advance before mandatory review joins.');
  }
  const completedNodeIds = sortedUnique([...progress.completedNodeIds, node.id]);
  const artifactRefs = sortedUnique([...progress.artifactRefs, ...envelope.artifactRefs]);
  if (!successor) {
    const aggregateVerdict = envelope.outcome === 'blocked' || envelope.outcome === 'rejected'
      ? 'Rejected'
      : envelope.outcome === 'needs-work' ? 'Needs Work' : 'Approved';
    return { ...progress, completedNodeIds, artifactRefs, aggregateVerdict };
  }
  if (!graph.nodes.some((candidate) => candidate.id === successor.node)) throw new Error(`Signed successor ${successor.node} is missing.`);
  const next = { ...progress, currentNodeId: successor.node, completedNodeIds, artifactRefs };
  if (successor.node === 'code-review') return startReviewTemplate(manifest, next, 'code-review');
  return next;
}

export function assertNodeResult(nodeId: string, outcome: RuntimeNodeOutcomeV1, result: unknown): void {
  if (!isPlainObject(result)) throw new Error(`Node ${nodeId} returned an invalid result contract.`);
  if (/^[ABC]-(?:full|closure(?:-\d+)?)$/u.test(nodeId)) {
    if (!isSortedUnique((result as Record<string, unknown>).findingIds)) {
      throw new Error(`Review node ${nodeId} returned invalid findingIds.`);
    }
    return;
  }
  if (nodeId === 'final-aggregation' || nodeId === 'fresh-context-review') {
    const verdict = outcome === 'approved' ? 'Approved' : outcome === 'needs-work' ? 'Needs Work' : outcome === 'rejected' ? 'Rejected' : undefined;
    const candidate = result as Record<string, unknown>;
    if (!verdict || candidate.verdict !== verdict || !isSortedUnique(candidate.findingIds)) {
      throw new Error(`Terminal node ${nodeId} returned an invalid verdict result.`);
    }
  }
}

export function expandReviewTemplate(manifest: RuntimeSkillBundleManifestV1, templateId: string): ExpandedReviewNodeV1[] {
  const template = manifest.graphTemplates[templateId];
  if (!template) throw new Error(`Unknown package review template: ${templateId}.`);
  let nodes: ExpandedReviewNodeV1[];
  if (template.kind === 'artifact-review' && template.profile === 'simple') {
    nodes = [full('A'), closure('A', 1, ['A-full']), closure('A', 2, ['A-closure-1'])];
  } else if (template.kind === 'artifact-review' && template.profile === 'medium') {
    nodes = [full('A'), closure('A', 1, ['A-full']), closure('A', 2, ['A-closure-1']), closure('A', 3, ['A-closure-2'])];
  } else if ((template.kind === 'artifact-review' && template.profile === 'high') || template.kind === 'code-review') {
    nodes = [
      full('A', 'initial'),
      full('B', 'initial'),
      { ...closure('A', undefined, ['A-full', 'B-full']), id: 'A-closure' },
      { ...closure('B', undefined, ['A-full', 'B-full']), id: 'B-closure' },
      full('C', null, ['A-closure', 'B-closure']),
      { ...closure('C', undefined, ['C-full']), id: 'C-closure' },
    ];
  } else {
    nodes = [full('A')];
  }
  if (nodes.length > template.maximumReviews) throw new Error(`Review template ${templateId} exceeds its signed budget.`);
  const fresh = new Set(nodes.filter((node) => node.mode === 'full').map((node) => node.reviewerSlot));
  if (fresh.size < template.requiredFreshReviewers) throw new Error(`Review template ${templateId} lacks required fresh reviewers.`);
  return nodes;
}

export function startReviewTemplate(
  manifest: RuntimeSkillBundleManifestV1,
  progress: GraphProgressRecordV2,
  templateId: string,
): GraphProgressRecordV2 {
  const template = manifest.graphTemplates[templateId];
  if (!template) throw new Error(`Unknown package review template: ${templateId}.`);
  if (progress.reviewBudget.maximum !== 0 || progress.reviewers.length !== 0) throw new Error('A review template is already active.');
  return {
    ...progress,
    templateId,
    reviewProfile: template.profile ?? undefined,
    reviewBudget: { maximum: template.maximumReviews, consumed: 0 },
  };
}

export function runnableReviewNodes(expanded: ExpandedReviewNodeV1[], progress: GraphProgressRecordV2): ExpandedReviewNodeV1[] {
  const completed = new Set(progress.joinIds);
  return expanded.filter((node) => !completed.has(node.id)
    && !(node.mode === 'closure' && fullReviewApprovedWithoutFindings(progress, node.reviewerSlot))
    && node.requires.every((required) => reviewRequirementSatisfied(progress, required)));
}

export function recordReviewNodeResult(
  expanded: ExpandedReviewNodeV1[],
  progress: GraphProgressRecordV2,
  result: ReviewNodeResultV1,
): GraphProgressRecordV2 {
  const node = expanded.find((candidate) => candidate.id === result.nodeId);
  if (!node || !runnableReviewNodes(expanded, progress).some((candidate) => candidate.id === node.id)) throw new Error(`Review node ${result.nodeId} is not runnable.`);
  if (!isText(result.reviewerId) || !isText(result.threadId) || !['Approved', 'Needs Work', 'Rejected'].includes(result.verdict)
    || !isSortedUnique(result.findingIds)) throw new Error('Invalid review node result.');
  if (progress.reviewBudget.consumed >= progress.reviewBudget.maximum) throw new Error('Review budget exhausted.');
  const expectedFull = node.mode === 'closure' ? progress.reviewers.find((reviewer) => reviewer.reviewerSlot === node.reviewerSlot && reviewer.mode === 'full') : undefined;
  const priorSlot = progress.reviewers.find((reviewer) => reviewer.reviewerId === result.reviewerId);
  if (node.mode === 'full' && priorSlot) throw new Error('Fresh review nodes require independent reviewers.');
  const priorThread = progress.reviewers.find((reviewer) => reviewer.threadId === result.threadId);
  if (priorThread && (node.mode === 'full' || priorThread.reviewerId !== result.reviewerId)) throw new Error('Review thread identity cannot be reused across reviewer slots.');
  if (node.mode === 'closure' && (!expectedFull || expectedFull.reviewerId !== result.reviewerId || expectedFull.threadId !== result.threadId)) {
    throw new Error('Closure review must reuse its exact reviewer full-session identity.');
  }
  if (node.mode === 'closure' && result.verdict !== 'Approved') throw new Error('A closure cannot join while findings remain unresolved.');
  const findings = sortedUnique([...progress.findings, ...result.findingIds]);
  const aggregateVerdict = result.verdict === 'Rejected' ? 'Rejected' : undefined;
  return {
    ...progress,
    joinIds: sortedUnique([...progress.joinIds, node.id]),
    reviewers: [...progress.reviewers, {
      nodeId: node.id, reviewerSlot: node.reviewerSlot, reviewerId: result.reviewerId, threadId: result.threadId,
      mode: node.mode, verdict: result.verdict, findingIds: result.findingIds,
    }],
    findings,
    reviewBudget: { ...progress.reviewBudget, consumed: progress.reviewBudget.consumed + 1 },
    closureCount: progress.closureCount + (node.mode === 'closure' ? 1 : 0),
    ...(aggregateVerdict ? { aggregateVerdict } : {}),
  };
}

export function prepareNodeAttempt(progress: GraphProgressRecordV2, input: {
  attemptId: string;
  executionId: string;
  nodeId: string;
  baseline: WorktreeBaselineV2;
  reportPath: string;
  intentPersistedAt: string;
}): GraphProgressRecordV2 {
  if (input.nodeId !== progress.currentNodeId) throw new Error('Attempt node is not current.');
  if (progress.attempts.some((attempt) => attempt.attemptId === input.attemptId || attempt.executions.some((execution) => execution.executionId === input.executionId))) throw new Error('Attempt identity must be unique.');
  const ordinal = progress.attempts.filter((attempt) => attempt.nodeId === input.nodeId).length + 1;
  const attempt: NodeAttemptRecordV2 = {
    attemptId: input.attemptId,
    nodeId: input.nodeId,
    ordinal,
    status: 'prepared',
    cleanRetriesConsumed: 0,
    partialContinuationsConsumed: 0,
    baseline: input.baseline,
    executions: [{
      executionId: input.executionId,
      kind: 'initial',
      status: 'prepared',
      intentPersistedAt: input.intentPersistedAt,
      report: { path: input.reportPath, atomicWriteComplete: false },
    }],
  };
  return { ...progress, attempts: [...progress.attempts, attempt] };
}

export function updateAttemptExecution(progress: GraphProgressRecordV2, input: {
  attemptId: string;
  executionId: string;
  process?: TransportExecutionRecordV2['process'];
  appServer?: TransportExecutionRecordV2['appServer'];
  report?: TransportExecutionRecordV2['report'];
  terminal?: TransportExecutionRecordV2['terminal'];
  recovery?: TransportExecutionRecordV2['recovery'];
  status: TransportExecutionRecordV2['status'];
}): GraphProgressRecordV2 {
  const attempts = progress.attempts.map((attempt) => {
    if (attempt.attemptId !== input.attemptId) return attempt;
    const executions = attempt.executions.map((execution) => {
      if (execution.executionId !== input.executionId) return execution;
      assertExecutionTransition(execution, input);
      const { attemptId: _attemptId, executionId: _executionId, ...changes } = input;
      return { ...execution, ...changes };
    });
    if (executions.every((execution, index) => execution === attempt.executions[index])) throw new Error('Execution identity is unavailable.');
    return { ...attempt, status: input.status, executions };
  });
  if (attempts.every((attempt, index) => attempt === progress.attempts[index])) throw new Error('Attempt identity is unavailable.');
  return { ...progress, attempts };
}

export function appendRecoveryExecution(progress: GraphProgressRecordV2, input: {
  attemptId: string;
  executionId: string;
  kind: 'clean-retry' | 'partial-continuation';
  reportPath: string;
  intentPersistedAt: string;
  baselineUnchanged: boolean;
  partialContinuationAllowed: boolean;
  recoveryArtifactPath?: string;
}): GraphProgressRecordV2 {
  const attempts = progress.attempts.map((attempt) => {
    if (attempt.attemptId !== input.attemptId) return attempt;
    if (!attempt.executions.some((execution) => execution.status === 'terminal' || execution.status === 'blocked')) throw new Error('Recovery requires a terminal prior execution.');
    if (input.kind === 'clean-retry' && (!input.baselineUnchanged || attempt.cleanRetriesConsumed !== 0)) throw new Error('Clean retry is unavailable.');
    if (input.kind === 'partial-continuation' && (!input.partialContinuationAllowed || !input.recoveryArtifactPath || attempt.partialContinuationsConsumed !== 0)) throw new Error('Partial continuation is unavailable.');
    if (attempt.executions.some((execution) => execution.executionId === input.executionId)) throw new Error('Execution identity must be unique.');
    return {
      ...attempt,
      status: 'prepared' as const,
      cleanRetriesConsumed: input.kind === 'clean-retry' ? 1 as const : attempt.cleanRetriesConsumed,
      partialContinuationsConsumed: input.kind === 'partial-continuation' ? 1 as const : attempt.partialContinuationsConsumed,
      executions: [...attempt.executions, {
        executionId: input.executionId,
        kind: input.kind,
        status: 'prepared' as const,
        intentPersistedAt: input.intentPersistedAt,
        report: { path: input.reportPath, atomicWriteComplete: false },
        recovery: input.kind === 'clean-retry'
          ? { kind: 'clean-retry' as const }
          : { kind: 'partial-continuation' as const, artifactPath: input.recoveryArtifactPath },
      }],
    };
  });
  if (attempts.every((attempt, index) => attempt === progress.attempts[index])) throw new Error('Attempt identity is unavailable.');
  return { ...progress, attempts };
}

export function intersectExecutionPolicy(
  signed: RuntimeExecutionPolicyV1,
  target: TargetExecutionPolicyV2,
  overrides: NodeExecutionOverridesV2 = {
    model: null,
    effort: null,
    timeoutMs: signed.timeoutMs,
    idleTimeoutMs: signed.idleTimeoutMs,
  },
): RuntimeExecutionPolicyV1 {
  assertTargetPolicy(target);
  const signedClasses = new Set(signed.writableRootClasses);
  if (Object.keys(target.mcpServers).length > 0 || signed.mcpTools.length > 0) throw new Error('orchestrator-mcp-catalog-fixture-missing: initial release requires an empty MCP catalog fixture.');
  if (signed.network === 'deny' && target.network !== 'deny') throw new Error('Target policy cannot widen signed network authority.');
  if (target.network === 'allow-listed') {
    const signedHosts = new Set(signed.networkHosts);
    for (const host of target.networkHosts) if (!signedHosts.has(host)) throw new Error(`Target policy cannot widen signed network authority with ${host}.`);
  }
  const writableRootClasses = target.writableRootClasses.filter((rootClass) => signedClasses.has(rootClass)).sort(compareUtf8);
  return {
    ...signed,
    worktreeAccess: writableRootClasses.includes('worktree') ? signed.worktreeAccess : 'read-only',
    sandboxMode: writableRootClasses.length > 0 ? signed.sandboxMode : 'read-only',
    writableRootClasses,
    network: signed.network === 'deny' || target.network === 'deny' ? 'deny' : 'allow-listed',
    networkHosts: signed.network === 'deny' || target.network === 'deny' ? [] : target.networkHosts,
    mcpTools: [],
    model: overrides.model ?? signed.model,
    effort: overrides.effort ?? signed.effort,
    timeoutMs: Math.min(signed.timeoutMs, overrides.timeoutMs),
    idleTimeoutMs: Math.min(signed.idleTimeoutMs, overrides.idleTimeoutMs),
  };
}

export function graphNode(manifest: RuntimeSkillBundleManifestV1, progress: GraphProgressRecordV2): RuntimeGraphNodeV1 {
  const node = manifest.graphs[progress.graphId]?.nodes.find((candidate) => candidate.id === progress.currentNodeId);
  if (!node) throw new Error(`Package graph node ${progress.currentNodeId} is unavailable.`);
  return node;
}

function assertEnvelope(value: unknown): asserts value is NodeControlEnvelopeV1 {
  const candidate = value as Record<string, unknown> | null;
  if (!candidate || typeof candidate !== 'object' || candidate.version !== 1 || !isText(candidate.nodeId)
    || typeof candidate.outcome !== 'string' || !['succeeded', 'blocked', 'route-small', 'route-spec-required', 'approved', 'needs-work', 'rejected'].includes(candidate.outcome)
    || !Array.isArray(candidate.artifactRefs) || candidate.artifactRefs.some((item: unknown) => !isText(item)) || new Set(candidate.artifactRefs).size !== candidate.artifactRefs.length
    || !isPlainObject(candidate.result)) {
    throw new Error('Invalid NodeControlEnvelopeV1.');
  }
}

function allowedTerminalOutcomes(node: RuntimeGraphNodeV1): RuntimeNodeOutcomeV1[] {
  if (node.successors.length > 0) return [];
  if (node.id === 'final-aggregation' || node.id === 'fresh-context-review') return ['approved', 'needs-work', 'rejected'];
  return ['succeeded', 'blocked'];
}

function assertExecutionTransition(current: TransportExecutionRecordV2, next: {
  status: TransportExecutionRecordV2['status'];
  process?: TransportExecutionRecordV2['process'];
  appServer?: TransportExecutionRecordV2['appServer'];
  report?: TransportExecutionRecordV2['report'];
  terminal?: TransportExecutionRecordV2['terminal'];
}): void {
  const allowed: Record<TransportExecutionRecordV2['status'], TransportExecutionRecordV2['status'][]> = {
    prepared: ['running', 'blocked'], running: ['running', 'terminal', 'blocked'], terminal: ['reconciled'], blocked: ['reconciled'], reconciled: [],
  };
  if (!allowed[current.status].includes(next.status)) throw new Error(`Illegal execution transition ${current.status} -> ${next.status}.`);
  if (next.appServer && !(current.process || next.process)) throw new Error('App-server identity requires persisted process identity.');
  if (current.process && next.process && JSON.stringify(current.process) !== JSON.stringify(next.process)) throw new Error('Persisted process identity is immutable.');
  if (current.appServer?.threadId && next.appServer && current.appServer.threadId !== next.appServer.threadId) throw new Error('Persisted thread identity is immutable.');
  if (current.appServer?.turnId && next.appServer?.turnId && current.appServer.turnId !== next.appServer.turnId) throw new Error('Persisted turn identity is immutable.');
  if (current.report.atomicWriteComplete && next.report && JSON.stringify(current.report) !== JSON.stringify(next.report)) throw new Error('Accepted report evidence is immutable.');
  if (current.terminal && next.terminal && JSON.stringify(current.terminal) !== JSON.stringify(next.terminal)) throw new Error('Terminal evidence is immutable.');
  if (next.status === 'reconciled' && (next.process || next.appServer || next.report || next.terminal)) throw new Error('Reconciliation cannot rewrite execution evidence.');
  if (next.status === 'terminal' && (!next.terminal || !next.report?.atomicWriteComplete || !next.report.sha256)) throw new Error('Terminal execution requires an accepted hashed report.');
  if (next.status === 'terminal' && next.terminal?.kind !== 'protocol-death' && (!(current.process || next.process) || !(current.appServer?.turnId || next.appServer?.turnId))) throw new Error('Terminal turn requires persisted process, thread, and turn identity.');
  if (next.status === 'reconciled' && current.status === 'terminal' && (!current.terminal || !current.report.atomicWriteComplete || !current.report.sha256)) throw new Error('Reconciliation requires accepted terminal evidence.');
}

function assertTargetPolicy(value: TargetExecutionPolicyV2): void {
  if (!['deny', 'allow-listed'].includes(value.network) || !isSortedUnique(value.networkHosts)
    || !isSortedUnique(value.writableRootClasses) || !isPlainObject(value.mcpServers)) throw new Error('Invalid target execution policy.');
  if (value.network === 'deny' && value.networkHosts.length > 0) throw new Error('Denied target network policy must have no hosts.');
  for (const host of value.networkHosts) if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host)) throw new Error(`Invalid target network host: ${host}.`);
}

function fullReviewApprovedWithoutFindings(progress: GraphProgressRecordV2, slot: string): boolean {
  const fullReview = progress.reviewers.find((reviewer) => reviewer.reviewerSlot === slot && reviewer.mode === 'full');
  return fullReview?.verdict === 'Approved' && fullReview.findingIds.length === 0;
}

function reviewRequirementSatisfied(progress: GraphProgressRecordV2, requirement: string): boolean {
  if (progress.joinIds.includes(requirement)) return true;
  const closure = /^([A-Z])-closure(?:-\d+)?$/u.exec(requirement);
  return Boolean(closure && fullReviewApprovedWithoutFindings(progress, closure[1]!));
}

function full(slot: string, parallelGroup: string | null = null, requires: string[] = []): ExpandedReviewNodeV1 {
  return { id: `${slot}-full`, reviewerSlot: slot, mode: 'full', parallelGroup, requires };
}
function closure(slot: string, ordinal?: number, requires: string[] = []): ExpandedReviewNodeV1 {
  return { id: `${slot}-closure${ordinal ? `-${ordinal}` : ''}`, reviewerSlot: slot, mode: 'closure', parallelGroup: null, requires };
}
function sortedUnique(values: string[]): string[] { return [...new Set(values)].sort(compareUtf8); }
function isSortedUnique(values: unknown): values is string[] { return Array.isArray(values) && values.every(isText) && new Set(values).size === values.length && values.every((value, index) => index === 0 || compareUtf8(values[index - 1]!, value) < 0); }
function isText(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
