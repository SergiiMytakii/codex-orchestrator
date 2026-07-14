import { createHash } from 'node:crypto';

import type { ImplementationPublishabilityResult } from './local-execution-session.js';
import {
  blockersFromReasons,
  type ReworkBlockerKey,
  type RunnerBlocker,
  type RunnerBlockerSource,
} from './rework-policy.js';

export type CandidateIdentity =
  | {
      kind: 'git-tree';
      headSha: string;
      treeSha: string;
      changedFiles: string[];
    }
  | {
      kind: 'worktree';
      headSha: string;
      changeSetHash: string;
      changedFiles: string[];
    }
  | {
      kind: 'legacy-unobserved';
      headSha: string;
      reason: 'promotion-before-change-set' | 'blocked-before-change-set';
    };

export interface LegacyPublishabilityNormalizationInput {
  issueNumber: number;
  baseSha: string;
  configHash: string;
  candidateIdentity: CandidateIdentity;
  result: ImplementationPublishabilityResult;
}

export interface EvaluationWarning {
  reason: string;
  evidenceRefs: string[];
}

export interface EvaluationSnapshot {
  version: 1;
  issueNumber: number;
  baseSha: string;
  configHash: string;
  candidateIdentity: CandidateIdentity;
  completionStatus: 'completed' | 'needs-promotion' | 'blocked';
  blockers: RunnerBlocker[];
  warnings: EvaluationWarning[];
  promotionRequest?: {
    reason: string;
    criteria: string[];
    evidence: string[];
  };
}

export type FindingDisposition =
  | 'safety-stop'
  | 'external-input'
  | 'scope-expansion'
  | 'diagnose'
  | 'residual-warning';

export type FindingSource = RunnerBlockerSource | 'residual-risk' | 'promotion';
export type FindingKey = ReworkBlockerKey | 'residual-warning' | 'scope-expansion' | 'finding-id-collision';

export interface Finding {
  id: string;
  source: FindingSource;
  key: FindingKey;
  reason: string;
  disposition: FindingDisposition;
  evidenceRefs: string[];
}

export interface EvaluationResult {
  findings: Finding[];
  blockingDisposition: 'safety-stop' | 'external-input' | 'diagnose' | 'none';
}

export function normalizeLegacyPublishability(
  input: LegacyPublishabilityNormalizationInput,
): EvaluationSnapshot {
  if (input.result.status === 'blocked') {
    return {
      version: 1,
      issueNumber: input.issueNumber,
      baseSha: input.baseSha,
      configHash: input.configHash,
      candidateIdentity: normalizeCandidateIdentity(input.candidateIdentity),
      completionStatus: 'blocked',
      blockers: mergeBlockers(input.result.blockers ?? [], blockersFromReasons(input.result.reasons)),
      warnings: uniqueSorted(input.result.residualRisks).map((reason) => ({
        reason,
        evidenceRefs: [],
      })),
    };
  }
  if (input.result.status === 'promotion-requested') {
    const promotion = input.result.report.promotion;
    if (!promotion) {
      throw new Error('Promotion-requested result is missing promotion evidence.');
    }
    return {
      version: 1,
      issueNumber: input.issueNumber,
      baseSha: input.baseSha,
      configHash: input.configHash,
      candidateIdentity: normalizeCandidateIdentity(input.candidateIdentity),
      completionStatus: 'needs-promotion',
      blockers: [],
      warnings: uniqueSorted(input.result.report.residualRisks).map((reason) => ({
        reason,
        evidenceRefs: [],
      })),
      promotionRequest: {
        reason: promotion.reason,
        criteria: uniqueSorted(promotion.criteria),
        evidence: uniqueSorted(promotion.evidence),
      },
    };
  }
  return {
    version: 1,
    issueNumber: input.issueNumber,
    baseSha: input.baseSha,
    configHash: input.configHash,
    candidateIdentity: normalizeCandidateIdentity(input.candidateIdentity),
    completionStatus: input.result.report.status,
    blockers: [],
    warnings: uniqueSorted(input.result.residualRisks).map((reason) => ({
      reason,
      evidenceRefs: [],
    })),
  };
}

export function evaluate(snapshot: EvaluationSnapshot): EvaluationResult {
  const findings = snapshot.blockers.map((blocker) => createFinding({
    source: blocker.source,
    key: blocker.key,
    reason: blocker.reason,
    disposition: blockerDisposition(blocker.key),
    evidenceRefs: [],
  }));
  findings.push(...snapshot.warnings.map((warning) => createFinding({
    source: 'residual-risk',
    key: 'residual-warning',
    reason: warning.reason,
    disposition: 'residual-warning',
    evidenceRefs: warning.evidenceRefs,
  })));
  if (snapshot.promotionRequest) {
    findings.push(createFinding({
      source: 'promotion',
      key: 'scope-expansion',
      reason: snapshot.promotionRequest.reason,
      disposition: 'scope-expansion',
      evidenceRefs: snapshot.promotionRequest.evidence,
    }));
  }

  findings.sort(compareFindings);
  return {
    findings,
    blockingDisposition: deriveBlockingDisposition(findings),
  };
}

function blockerDisposition(key: ReworkBlockerKey): FindingDisposition {
  if (key === 'denied-path' || key === 'publication-violation' || key === 'destructive-or-production-action') {
    return 'safety-stop';
  }
  if (key === 'required-figma-mcp-failure') {
    return 'external-input';
  }
  return 'diagnose';
}

function deriveBlockingDisposition(findings: Finding[]): EvaluationResult['blockingDisposition'] {
  if (findings.some((finding) => finding.disposition === 'safety-stop')) {
    return 'safety-stop';
  }
  if (findings.some((finding) => finding.disposition === 'external-input')) {
    return 'external-input';
  }
  if (findings.some((finding) =>
    finding.disposition === 'diagnose' || finding.disposition === 'scope-expansion')) {
    return 'diagnose';
  }
  return 'none';
}

function normalizeCandidateIdentity(identity: CandidateIdentity): CandidateIdentity {
  if (identity.kind === 'legacy-unobserved') {
    return { ...identity };
  }
  return {
    ...identity,
    changedFiles: uniqueSorted(identity.changedFiles),
  };
}

function mergeBlockers(typed: RunnerBlocker[], inferred: RunnerBlocker[]): RunnerBlocker[] {
  const merged = new Map<string, RunnerBlocker>();
  for (const blocker of [...typed, ...inferred]) {
    const reason = normalizeReason(blocker.reason);
    const key = JSON.stringify([blocker.key, reason, blocker.source]);
    if (!merged.has(key)) {
      merged.set(key, { ...blocker, reason });
    }
  }
  return Array.from(merged.values()).sort((left, right) =>
    compareCodeUnits(left.source, right.source)
    || compareCodeUnits(left.key, right.key)
    || compareCodeUnits(left.reason, right.reason));
}

function createFinding(input: Omit<Finding, 'id'>): Finding {
  const reason = normalizeReason(input.reason);
  const evidenceRefs = uniqueSorted(input.evidenceRefs);
  const canonical = JSON.stringify({
    version: 1,
    source: input.source,
    key: input.key,
    normalizedReason: reason,
    evidenceRefs,
  });
  const digest = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
  return {
    id: `finding:v1:${digest}`,
    source: input.source,
    key: input.key,
    reason,
    disposition: input.disposition,
    evidenceRefs,
  };
}

function normalizeReason(value: string): string {
  const lines = value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[\t ]+/gu, ' '));
  while (lines[0] === '') {
    lines.shift();
  }
  while (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.join('\n');
}

const dispositionRank: Record<FindingDisposition, number> = {
  'safety-stop': 0,
  'external-input': 1,
  'scope-expansion': 2,
  diagnose: 3,
  'residual-warning': 4,
};

function compareFindings(left: Finding, right: Finding): number {
  return dispositionRank[left.disposition] - dispositionRank[right.disposition]
    || compareCodeUnits(left.source, right.source)
    || compareCodeUnits(left.key, right.key)
    || compareCodeUnits(left.id, right.id);
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
