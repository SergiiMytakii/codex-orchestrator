import type { FrozenCriterion, IssueSnapshot } from './acceptance-proof.js';
import type { AgentAutoConfig } from './config.js';
import { canonicalJson } from './containment.js';
import type { RunRecord, RunStateInspection, RunTerminalOutcome } from './run-store.js';

interface IssueObservation {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  comments: Array<{ id?: string; body: string; authorAssociation: string; createdAt?: string; updatedAt?: string }>;
}

const claimMarkerPattern = /^<!-- codex-orchestrator:run:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):claim -->$/u;

export function isClaimMarkerComment(comment: { body: string }): boolean {
  return claimMarkerPattern.test(comment.body.split('\n')[0] ?? '');
}

export function isExactClaimMarkerLine(line: string): boolean {
  return claimMarkerPattern.test(line);
}

export function claimRunId(comment: { body: string }): string | undefined {
  return (comment.body.split('\n')[0] ?? '').match(claimMarkerPattern)?.[1];
}

function trustedHistoricalClaimBodyKey(
  comment: { body: string; authorAssociation: string }, issueNumber: number, branchName: string,
): string | undefined {
  const runId = claimRunId(comment);
  if (!runId || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.authorAssociation)) return undefined;
  if (comment.body !== claimComment(runId, issueNumber, branchName)) return undefined;
  return `${comment.authorAssociation}\u0000${comment.body}`;
}

function frozenHistoricalClaimKey(
  comment: { id?: string; body: string; authorAssociation: string }, issueNumber: number, branchName: string,
): string | undefined {
  const bodyKey = trustedHistoricalClaimBodyKey(comment, issueNumber, branchName);
  if (!bodyKey) return undefined;
  return comment.id ? `id\u0000${comment.id}\u0000${bodyKey}` : `legacy\u0000${bodyKey}`;
}

export function observedHistoricalClaimKeys(comment: IssueObservation['comments'][number], record: RunRecord): string[] {
  const bodyKey = trustedHistoricalClaimBodyKey(comment, record.issueNumber, record.branchName);
  if (!bodyKey) return [];
  const keys = comment.id ? [`id\u0000${comment.id}\u0000${bodyKey}`] : [];
  if (timestampAtOrBefore(comment.createdAt, record.createdAt) && timestampAtOrBefore(comment.updatedAt, record.createdAt)) {
    keys.push(`legacy\u0000${bodyKey}`);
  }
  return keys;
}

function timestampAtOrBefore(value: string | undefined, cutoff: string): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && timestamp <= Date.parse(cutoff);
}

export function historicalClaimCounts(record: RunRecord): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of record.issueSnapshot.comments ?? []) {
    const key = frozenHistoricalClaimKey(comment, record.issueNumber, record.branchName);
    if (!key || claimRunId(comment) === record.runId) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function refreshClaimedIssueSnapshot(baseline: RunRecord['issueSnapshot'], issue: IssueObservation): RunRecord['issueSnapshot'] {
  return {
    ...structuredClone(baseline),
    comments: [
      ...(baseline.comments ?? []).filter(isClaimMarkerComment),
      ...issue.comments.filter((comment) => !isClaimMarkerComment(comment)),
    ],
  };
}

export function snapshotIssue(issue: IssueObservation): IssueSnapshot & Pick<IssueObservation, 'comments'> {
  if (issue.state !== 'OPEN') throw new Error('cannot snapshot a closed issue');
  return {
    number: issue.number, title: issue.title, body: issue.body, url: issue.url, state: 'OPEN',
    labels: sortedUnique(issue.labels), comments: structuredClone(issue.comments),
  };
}

export function publicIssueSnapshot(issue: IssueSnapshot): IssueSnapshot {
  return { number: issue.number, title: issue.title, body: issue.body, url: issue.url, state: issue.state, labels: [...issue.labels] };
}

export function freezeCriteria(issue: IssueSnapshot): FrozenCriterion[] {
  const lines = issue.body.split(/\r?\n/u);
  const heading = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/iu.test(line.trim()));
  const texts: string[] = [];
  if (heading >= 0) {
    for (const line of lines.slice(heading + 1)) {
      if (/^#{1,6}\s+/u.test(line.trim())) break;
      const text = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/u)?.[1]?.trim();
      if (text && !texts.includes(text)) texts.push(text);
    }
  }
  if (texts.length === 0) return [{ id: 'fallback-001', order: 1, source: 'fallback', text: `${issue.title}\n\n${issue.body}` }];
  return texts.map((text, index) => ({ id: `ac-${String(index + 1).padStart(3, '0')}`, order: index + 1, source: 'explicit', text }));
}

export function claimComment(runId: string, issueNumber: number, branchName: string): string {
  return `<!-- codex-orchestrator:run:${runId}:claim -->\ncodex-orchestrator claimed #${issueNumber} for branch ${branchName}`;
}

export function blockedLabelPolicy(config: AgentAutoConfig) {
  return {
    auto: config.github.labels.auto.name, running: config.github.labels.running.name,
    blocked: config.github.labels.blocked.name, review: config.github.labels.review.name,
  };
}

export function blockedLabelProjection(
  labels: string[], config: AgentAutoConfig,
): { status: 'settled'; expected: string[] } | { status: 'transition' | 'diverged' } {
  const policy = blockedLabelPolicy(config);
  const present = new Set(labels);
  if (present.has(policy.review)) return { status: 'transition' };
  const auto = present.has(policy.auto);
  const running = present.has(policy.running);
  const blocked = present.has(policy.blocked);
  if (running || (auto && !blocked)) return { status: 'transition' };
  if (blocked) return { status: 'settled', expected: auto ? [policy.auto, policy.blocked].sort() : [policy.blocked] };
  return { status: 'settled', expected: [] };
}

export function sameStrings(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function isAdoptableAttempt(attempt: RunRecord['activeAttempt']): boolean {
  return attempt?.stage === 'launched' || (attempt?.stage === 'observed' && attempt.result !== null);
}

export function semanticChangesMatch(record: RunRecord, changes: Omit<Partial<RunRecord>, 'activeAttempt'>): boolean {
  return Object.entries(changes).every(([key, expected]) => {
    const observed = record[key as keyof RunRecord];
    return expected === undefined ? observed === undefined : canonicalJson(observed) === canonicalJson(expected);
  });
}

export function sameInspectionIdentity(
  left: Pick<RunStateInspection, 'status' | 'rawSha256'>,
  right: Pick<RunStateInspection, 'status' | 'rawSha256'>,
): boolean {
  return left.status === right.status && left.rawSha256 === right.rawSha256;
}

export function publicOutcome(outcome: RunTerminalOutcome) {
  if (outcome.status === 'internal-error') return { status: 'internal-error' as const, evidencePath: outcome.evidencePath };
  return structuredClone(outcome);
}

export function outcomeEvidenceBytes(input: { runId: string; code: string; summary: string; recordedAt: string }): Buffer {
  return Buffer.from(`${canonicalJson({
    version: 1, runId: input.runId, code: input.code, summary: input.summary, recordedAt: input.recordedAt,
  })}\n`, 'utf8');
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
