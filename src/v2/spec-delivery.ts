import { createHash } from 'node:crypto';

import { canonicalJson } from './containment.js';
import { validateCodeReviewDefects, type CodeReviewDefectV1 } from './code-review-report.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const MANDATORY_COVERAGE = [
  'approved-product-intent', 'deterministic-executability', 'safety', 'scope', 'validation',
] as const;

export interface SpecEvidenceV1 { path: string; sha256: string; description: string }
export interface SpecActorV1 { attemptId: string; sessionId: string }
export interface SpecRevisionV1 {
  version: 1;
  revision: number;
  path: string;
  content: string;
  contentSha256: string;
  evidence: SpecEvidenceV1[];
  author: SpecActorV1;
  previousRevisionSha256: string | null;
  revisionSha256: string;
}
export interface SpecAcceptedRiskV1 {
  defectId: string;
  rationale: string;
  policy: string;
  acceptedBy: string;
}
export interface SpecReviewReportV1 {
  version: 1;
  targetRevision: number;
  targetSha256: string;
  mode: 'full' | 'closure';
  verdict: 'approved' | 'needs-work' | 'rejected';
  reviewer: SpecActorV1;
  coverage: string[];
  defects: CodeReviewDefectV1[];
  affectedDefectIds: string[];
  affectedContracts: string[];
  closureRequestSha256: string | null;
  acceptedRisks: SpecAcceptedRiskV1[];
  coverageInvalidated: boolean;
}
export interface FrozenSpecReceiptV1 {
  version: 1;
  issueNumber: number;
  runId: string;
  workflowGenerationSha256: string;
  revision: number;
  path: string;
  contentSha256: string;
  revisionSha256: string;
  reviewReportSha256: string;
  reviewerSessionId: string;
  receiptSha256: string;
}
export interface SpecDecisionGapV1 { id: string; summary: string; evidence: string[] }
export interface FrozenSpecQuestionReceiptV1 {
  version: 1;
  revisionSha256: string;
  decisionGaps: SpecDecisionGapV1[];
  questionId: string;
  question: string;
  answerPrefix: string;
  marker: string;
  evidencePath: string;
  questionSha256: string;
}
export interface TrustedSpecAnswerV1 {
  accepted: boolean;
  questionSha256: string;
  commentId: string;
  authorId: string;
  author: string;
  answerPrefix: string;
  normalizedAnswer: string;
  normalizedSha256: string;
  permissionCheckedAt: string;
  commentCreatedAt: string;
  commentUpdatedAt: string;
}
export interface SpecDeliveryV1 {
  version: 1;
  issueNumber: number;
  runId: string;
  workflowGenerationSha256: string;
  stage: 'authoring' | 'answer-authoring' | 'question' | 'review-full' | 'author-repair' | 'review-closure' | 'approved' | 'frozen' | 'rejected' | 'exhausted';
  revisions: SpecRevisionV1[];
  acceptedAnswers: TrustedSpecAnswerV1[];
  authorSessionId: string | null;
  review: {
    reviewer: SpecActorV1 | null;
    mode: 'full' | 'closure' | null;
    coverage: string[];
    defects: CodeReviewDefectV1[];
    affectedDefectIds: string[];
    affectedContracts: string[];
    closureRequestSha256: string | null;
    acceptedRisks: SpecAcceptedRiskV1[];
    acceptedReportSha256: string | null;
  };
  budgets: {
    author: { reportRepairs: 0 | 1; transportRetries: 0 | 1 };
    review: { reportRepairs: 0 | 1; transportRetries: 0 | 1 };
    repairCycles: 0 | 1;
  };
  frozen?: FrozenSpecReceiptV1;
  question?: FrozenSpecQuestionReceiptV1;
  trustedAnswer?: TrustedSpecAnswerV1;
}

export function createInitialSpecDelivery(input: {
  issueNumber: number; runId: string; workflowGenerationSha256: string;
}): SpecDeliveryV1 {
  positive(input.issueNumber, 'issue number'); text(input.runId, 'run ID'); hash(input.workflowGenerationSha256, 'workflow generation hash');
  return {
    version: 1, ...input, stage: 'authoring', revisions: [], acceptedAnswers: [], authorSessionId: null,
    review: { reviewer: null, mode: null, coverage: [], defects: [], affectedDefectIds: [], affectedContracts: [], closureRequestSha256: null, acceptedRisks: [], acceptedReportSha256: null },
    budgets: { author: { reportRepairs: 0, transportRetries: 0 }, review: { reportRepairs: 0, transportRetries: 0 }, repairCycles: 0 },
  };
}

export function createSpecRevision(input: {
  revision: number; path: string; content: string; evidence: SpecEvidenceV1[]; author: SpecActorV1; previousRevision: SpecRevisionV1 | null;
}): SpecRevisionV1 {
  const base = {
    version: 1 as const, revision: input.revision, path: input.path, content: input.content,
    contentSha256: digest(input.content), evidence: structuredClone(input.evidence), author: structuredClone(input.author),
    previousRevisionSha256: input.previousRevision?.revisionSha256 ?? null,
  };
  return { ...base, revisionSha256: hashSpecRevision(base) };
}

export function hashSpecRevision(revision: Omit<SpecRevisionV1, 'revisionSha256'> | SpecRevisionV1): string {
  const { revisionSha256: _ignored, ...payload } = revision as SpecRevisionV1;
  return digest(`codex-orchestrator-spec-revision-v1\0${canonicalJson(payload)}`);
}

export function validateSpecRevision(value: unknown, previous: SpecRevisionV1 | null): SpecRevisionV1 {
  exact(value, ['version','revision','path','content','contentSha256','evidence','author','previousRevisionSha256','revisionSha256'], 'spec revision');
  if (value.version !== 1) throw new Error('spec revision version is invalid');
  positive(value.revision, 'spec revision number'); text(value.path, 'spec revision path');
  if (typeof value.content !== 'string' || value.content.length === 0) throw new Error('spec revision content is invalid');
  if (value.contentSha256 !== digest(value.content)) throw new Error('spec revision content hash is invalid');
  actor(value.author, 'spec revision author');
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) throw new Error('spec revision evidence is invalid');
  for (const evidence of value.evidence) { exact(evidence, ['path','sha256','description'], 'spec evidence'); text(evidence.path, 'evidence path'); hash(evidence.sha256, 'evidence hash'); text(evidence.description, 'evidence description'); }
  if (value.previousRevisionSha256 !== (previous?.revisionSha256 ?? null)) throw new Error('spec revision chain is invalid');
  if (previous && (value.revision !== previous.revision + 1 || value.path === previous.path)) throw new Error('spec revision chain is not append-only');
  if (!previous && value.revision !== 1) throw new Error('first spec revision number is invalid');
  if (value.revisionSha256 !== hashSpecRevision(value as SpecRevisionV1)) throw new Error('spec revision hash is invalid');
  return structuredClone(value as unknown as SpecRevisionV1);
}

export function acceptSpecRevision(state: SpecDeliveryV1, revision: SpecRevisionV1): SpecDeliveryV1 {
  if (!['authoring', 'author-repair', 'answer-authoring'].includes(state.stage)) throw new Error('spec is not ready for an author result');
  actor(revision.author, 'spec revision author');
  if (state.authorSessionId && state.authorSessionId !== revision.author.sessionId) throw new Error('spec author session changed');
  const previous = state.revisions.at(-1) ?? null;
  const validated = validateSpecRevision(revision, previous);
  const defects = state.stage === 'author-repair'
    ? state.review.defects.map((defect) => state.review.affectedDefectIds.includes(defect.id) && ['open','reopened'].includes(defect.status)
      ? { ...defect, status: 'fixed' as const, statusTargetRevision: validated.revision } : structuredClone(defect))
    : state.review.defects;
  const next: SpecDeliveryV1 = {
    ...structuredClone(state), stage: state.stage === 'author-repair' ? 'review-closure' : 'review-full',
    revisions: [...state.revisions, validated], authorSessionId: revision.author.sessionId,
    review: { ...structuredClone(state.review), defects },
  };
  if (state.stage === 'answer-authoring' && state.trustedAnswer?.accepted) next.acceptedAnswers.push(structuredClone(state.trustedAnswer));
  delete next.question;
  delete next.trustedAnswer;
  if (next.stage === 'review-closure') next.review.closureRequestSha256 = hashSpecClosureRequest(next);
  return validateSpecDelivery(next);
}

export function freezeSpecQuestion(state: SpecDeliveryV1, revision: SpecRevisionV1, gaps: SpecDecisionGapV1[], question: string): SpecDeliveryV1 {
  if (!['authoring', 'answer-authoring'].includes(state.stage)) throw new Error('spec is not ready for a product question');
  if (!Array.isArray(gaps) || gaps.length === 0 || gaps.some((gap) => !gap.id || !gap.summary || !Array.isArray(gap.evidence) || gap.evidence.length === 0)) {
    throw new Error('spec decision gaps are invalid');
  }
  const validated = validateSpecRevision(revision, state.revisions.at(-1) ?? null);
  const questionId = `q-${validated.revisionSha256.slice(0, 20)}`;
  const answerPrefix = `Answer ${questionId}:`;
  const marker = `<!-- codex-orchestrator:spec-question:${questionId} -->`;
  const base = {
    version: 1 as const, revisionSha256: validated.revisionSha256, decisionGaps: structuredClone(gaps),
    questionId, question, answerPrefix, marker, evidencePath: validated.path,
  };
  const receipt = { ...base, questionSha256: digest(`codex-orchestrator-spec-question-v1\0${canonicalJson(base)}`) };
  const next = { ...structuredClone(state), stage: 'question' as const, revisions: [...state.revisions, validated], question: receipt };
  delete next.trustedAnswer;
  return validateSpecDelivery(next);
}

export function acceptTrustedSpecAnswer(state: SpecDeliveryV1, answer: TrustedSpecAnswerV1): SpecDeliveryV1 {
  if (state.stage !== 'question' || !state.question || answer.questionSha256 !== state.question.questionSha256) {
    throw new Error('trusted spec answer correlation mismatch');
  }
  const next = { ...structuredClone(state), stage: 'answer-authoring' as const, trustedAnswer: structuredClone(answer) };
  return validateSpecDelivery(next);
}

export function acceptSpecReview(state: SpecDeliveryV1, report: SpecReviewReportV1, reportSha256: string): SpecDeliveryV1 {
  hash(reportSha256, 'spec review report hash');
  if (state.stage !== 'review-full' && state.stage !== 'review-closure') throw new Error('spec is not ready for a review result');
  const target = state.revisions.at(-1)!;
  validateReviewReport(report);
  validateCodeReviewDefects(report.defects, report.targetRevision);
  if (report.acceptedRisks.length !== 0) throw new Error('reviewer cannot authorize accepted risks');
  if (report.targetRevision !== target.revision || report.targetSha256 !== target.revisionSha256
    || report.mode !== (state.stage === 'review-full' ? 'full' : 'closure')
    || report.reviewer.sessionId === state.authorSessionId
    || (state.review.reviewer !== null && report.reviewer.sessionId !== state.review.reviewer.sessionId)
    || report.closureRequestSha256 !== (state.stage === 'review-closure' ? state.review.closureRequestSha256 : null)) throw new Error('spec review correlation mismatch');
  for (const required of MANDATORY_COVERAGE) if (!report.coverage.includes(required)) throw new Error('spec review omitted mandatory coverage');
  if (report.mode === 'closure' && report.coverageInvalidated) {
    const next = structuredClone(state);
    next.stage = 'review-full';
    next.review.mode = 'full';
    next.review.closureRequestSha256 = null;
    next.review.affectedDefectIds = [];
    next.review.affectedContracts = [];
    return validateSpecDelivery(next);
  }
  const defects = report.mode === 'closure' ? mergeClosureDefects(state, report) : structuredClone(report.defects);
  if (report.mode === 'closure') validateClosure(state, report);
  if (report.verdict === 'approved') {
    const accepted = new Set(report.acceptedRisks.map((risk) => risk.defectId));
    const unresolved = defects.filter((defect) => ['blocker','execution-risk'].includes(defect.class) && !['verified','superseded'].includes(defect.status) && !accepted.has(defect.id));
    if (unresolved.length) throw new Error('approved spec review has unresolved mandatory defects');
  }
  const next: SpecDeliveryV1 = {
    ...structuredClone(state),
    stage: report.verdict === 'approved' ? 'approved'
      : report.verdict === 'needs-work' && state.budgets.repairCycles === 0 ? 'author-repair'
      : report.verdict === 'needs-work' ? 'exhausted' : 'rejected',
    review: {
      reviewer: structuredClone(report.reviewer), mode: report.mode, coverage: sorted(report.coverage),
      defects: defects.sort((a,b) => a.id.localeCompare(b.id)),
      affectedDefectIds: report.verdict === 'needs-work' ? sorted(report.defects.filter((defect) => ['open','reopened'].includes(defect.status)).map((defect) => defect.id)) : [],
      affectedContracts: report.verdict === 'needs-work' ? sorted(report.affectedContracts) : [],
      closureRequestSha256: null, acceptedRisks: structuredClone(report.acceptedRisks), acceptedReportSha256: reportSha256,
    },
    budgets: {
      ...structuredClone(state.budgets),
      repairCycles: report.verdict === 'needs-work' && state.budgets.repairCycles === 0 ? 1 : state.budgets.repairCycles,
    },
  };
  return validateSpecDelivery(next);
}

export function hashSpecClosureRequest(state: SpecDeliveryV1): string {
  const target = state.revisions.at(-1);
  if (!target) throw new Error('Closure target revision is missing');
  return digest(`codex-orchestrator-spec-closure-v1\0${canonicalJson({
    targetRevision: target.revision, targetSha256: target.revisionSha256,
    affectedDefectIds: sorted(state.review.affectedDefectIds), affectedContracts: sorted(state.review.affectedContracts),
    defects: state.review.defects,
  })}`);
}

export function consumeSpecReportRepair(state: SpecDeliveryV1, owner: 'author' | 'review'): SpecDeliveryV1 {
  if (state.budgets[owner].reportRepairs !== 0) throw new Error(`${owner} report repair budget exhausted`);
  return { ...structuredClone(state), budgets: { ...structuredClone(state.budgets), [owner]: { ...state.budgets[owner], reportRepairs: 1 } } };
}

export function recoverMalformedSpecReport(state: SpecDeliveryV1, owner: 'author' | 'review'): SpecDeliveryV1 {
  return validateSpecDelivery(consumeSpecReportRepair(state, owner));
}

export function consumeSpecTransportRetry(state: SpecDeliveryV1, owner: 'author' | 'review'): SpecDeliveryV1 {
  if (state.budgets[owner].transportRetries !== 0) throw new Error(`${owner} transport retry budget exhausted`);
  const next = structuredClone(state);
  next.budgets[owner].transportRetries = 1;
  return validateSpecDelivery(next);
}

export function freezeApprovedSpec(state: SpecDeliveryV1): SpecDeliveryV1 {
  validateSpecDelivery(state);
  if (state.stage !== 'approved' || !state.review.reviewer || !state.review.acceptedReportSha256) throw new Error('spec is not independently approved');
  const revision = state.revisions.at(-1)!;
  const payload = {
    version: 1 as const, issueNumber: state.issueNumber, runId: state.runId,
    workflowGenerationSha256: state.workflowGenerationSha256, revision: revision.revision, path: revision.path,
    contentSha256: revision.contentSha256, revisionSha256: revision.revisionSha256,
    reviewReportSha256: state.review.acceptedReportSha256, reviewerSessionId: state.review.reviewer.sessionId,
  };
  const frozen = { ...payload, receiptSha256: frozenDigest(payload) };
  const next: SpecDeliveryV1 = { ...structuredClone(state), stage: 'frozen', frozen };
  return validateSpecDelivery(next);
}

export function validateFrozenSpecReceipt(value: unknown, state: SpecDeliveryV1): FrozenSpecReceiptV1 {
  exact(value, ['version','issueNumber','runId','workflowGenerationSha256','revision','path','contentSha256','revisionSha256','reviewReportSha256','reviewerSessionId','receiptSha256'], 'frozen spec receipt');
  const revision = state.revisions.at(-1);
  if (!revision || value.version !== 1 || value.issueNumber !== state.issueNumber || value.runId !== state.runId
    || value.workflowGenerationSha256 !== state.workflowGenerationSha256 || value.revision !== revision.revision
    || value.path !== revision.path || value.contentSha256 !== revision.contentSha256 || value.revisionSha256 !== revision.revisionSha256
    || value.reviewReportSha256 !== state.review.acceptedReportSha256 || value.reviewerSessionId !== state.review.reviewer?.sessionId) {
    throw new Error('frozen spec receipt binding is invalid');
  }
  const { receiptSha256, ...payload } = value as unknown as FrozenSpecReceiptV1;
  if (receiptSha256 !== frozenDigest(payload)) throw new Error('frozen spec receipt hash is invalid');
  return structuredClone(value as unknown as FrozenSpecReceiptV1);
}

export function validateSpecDelivery(value: unknown): SpecDeliveryV1 {
  const optional = ['frozen', 'question', 'trustedAnswer'].filter((key) => own(value, key));
  exact(value, ['version','issueNumber','runId','workflowGenerationSha256','stage','revisions','acceptedAnswers','authorSessionId','review','budgets',...optional], 'spec delivery');
  if (value.version !== 1) throw new Error('spec delivery version is invalid');
  positive(value.issueNumber, 'issue number'); text(value.runId, 'run ID'); hash(value.workflowGenerationSha256, 'workflow generation hash');
  if (!['authoring','answer-authoring','question','review-full','author-repair','review-closure','approved','frozen','rejected','exhausted'].includes(value.stage as string)) throw new Error('spec delivery stage is invalid');
  if (!Array.isArray(value.revisions)) throw new Error('spec revisions are invalid');
  let previous: SpecRevisionV1 | null = null;
  for (const revision of value.revisions) previous = validateSpecRevision(revision, previous);
  if (!Array.isArray(value.acceptedAnswers)) throw new Error('accepted spec answers are invalid');
  for (const answer of value.acceptedAnswers) validateTrustedSpecAnswer(answer);
  exact(value.budgets, ['author','review','repairCycles'], 'spec budgets');
  for (const owner of ['author','review'] as const) { exact(value.budgets[owner], ['reportRepairs','transportRetries'], `${owner} budget`); for (const key of ['reportRepairs','transportRetries'] as const) if (![0,1].includes(value.budgets[owner][key])) throw new Error('spec budget is invalid'); }
  if (![0,1].includes(value.budgets.repairCycles)) throw new Error('spec repair cycle budget is invalid');
  validateReviewState(value.review);
  const stage = value.stage as SpecDeliveryV1['stage'];
  if (stage === 'authoring' && value.revisions.length !== 0) throw new Error('authoring stage has revisions');
  if (stage !== 'authoring' && value.revisions.length === 0) throw new Error('spec stage requires a revision');
  if (stage === 'question' || stage === 'answer-authoring') validateSpecQuestion(value.question, value.revisions.at(-1) as SpecRevisionV1);
  else if (own(value, 'question')) throw new Error('non-question spec has question evidence');
  if (stage === 'answer-authoring') validateTrustedSpecAnswer(value.trustedAnswer, value.question);
  else if (own(value, 'trustedAnswer')) throw new Error('non-answering spec has trusted answer');
  if (stage === 'approved' && (!value.review.reviewer || !value.review.acceptedReportSha256)) throw new Error('approved spec is missing review authority');
  if (stage === 'frozen') validateFrozenSpecReceipt(value.frozen, value as unknown as SpecDeliveryV1);
  else if (own(value, 'frozen')) throw new Error('non-frozen spec has a frozen receipt');
  return structuredClone(value as unknown as SpecDeliveryV1);
}

function validateSpecQuestion(value: unknown, revision: SpecRevisionV1): void {
  exact(value, ['version','revisionSha256','decisionGaps','questionId','question','answerPrefix','marker','evidencePath','questionSha256'], 'spec question');
  if (value.version !== 1 || value.revisionSha256 !== revision.revisionSha256 || value.evidencePath !== revision.path) throw new Error('spec question revision binding is invalid');
  text(value.questionId, 'spec question ID'); text(value.question, 'spec question'); text(value.answerPrefix, 'spec answer prefix'); text(value.marker, 'spec question marker');
  if (!Array.isArray(value.decisionGaps) || value.decisionGaps.length === 0) throw new Error('spec decision gaps are invalid');
  for (const gap of value.decisionGaps) {
    exact(gap, ['id','summary','evidence'], 'spec decision gap'); text(gap.id, 'spec gap ID'); text(gap.summary, 'spec gap summary');
    if (!Array.isArray(gap.evidence) || gap.evidence.length === 0) throw new Error('spec gap evidence is invalid');
    for (const item of gap.evidence) text(item, 'spec gap evidence');
  }
  const expectedId = `q-${revision.revisionSha256.slice(0, 20)}`;
  if (value.questionId !== expectedId || value.answerPrefix !== `Answer ${expectedId}:`
    || value.marker !== `<!-- codex-orchestrator:spec-question:${expectedId} -->`) throw new Error('spec question identity is invalid');
  const { questionSha256, ...base } = value as FrozenSpecQuestionReceiptV1;
  if (questionSha256 !== digest(`codex-orchestrator-spec-question-v1\0${canonicalJson(base)}`)) throw new Error('spec question hash is invalid');
}

function validateTrustedSpecAnswer(value: unknown, question?: unknown): void {
  exact(value, ['accepted','questionSha256','commentId','authorId','author','answerPrefix','normalizedAnswer','normalizedSha256','permissionCheckedAt','commentCreatedAt','commentUpdatedAt'], 'trusted spec answer');
  if (typeof value.accepted !== 'boolean') throw new Error('trusted spec answer acceptance is invalid');
  text(value.commentId, 'answer comment ID'); text(value.authorId, 'answer author ID'); text(value.author, 'answer author'); text(value.answerPrefix, 'answer prefix'); text(value.normalizedAnswer, 'answer'); text(value.permissionCheckedAt, 'permission checked at'); text(value.commentCreatedAt, 'answer created at'); text(value.commentUpdatedAt, 'answer updated at');
  if (value.accepted && value.commentCreatedAt !== value.commentUpdatedAt) throw new Error('accepted spec answer was edited');
  hash(value.normalizedSha256, 'normalized answer hash');
  if (value.normalizedSha256 !== digest(value.normalizedAnswer as string)) throw new Error('normalized answer hash mismatch');
  if (question && (value.questionSha256 !== (question as FrozenSpecQuestionReceiptV1).questionSha256
    || value.answerPrefix !== (question as FrozenSpecQuestionReceiptV1).answerPrefix)) throw new Error('trusted spec answer question mismatch');
}

function validateClosure(state: SpecDeliveryV1, report: SpecReviewReportV1): void {
  if (canonicalJson(sorted(report.affectedDefectIds)) !== canonicalJson(sorted(state.review.affectedDefectIds))) throw new Error('Closure affected defect IDs mismatch');
  const reported = new Map(report.defects.map((defect) => [defect.id, defect]));
  for (const defect of state.review.defects) {
    const next = reported.get(defect.id);
    if (state.review.affectedDefectIds.includes(defect.id) && !next) throw new Error('Closure omitted affected defect IDs');
    if (!state.review.affectedDefectIds.includes(defect.id) && next && canonicalJson(next) !== canonicalJson(defect)) throw new Error('Closure changed unaffected defect');
  }
}

function mergeClosureDefects(state: SpecDeliveryV1, report: SpecReviewReportV1): CodeReviewDefectV1[] {
  const reported = new Map(report.defects.map((defect) => [defect.id, defect]));
  const affected = new Set(state.review.affectedDefectIds);
  const merged = state.review.defects.map((defect) => {
    const next = reported.get(defect.id);
    if (!affected.has(defect.id)) return structuredClone(defect);
    if (!next) throw new Error('Closure omitted affected defect IDs');
    for (const field of ['id','class','invariant','failure','introducedTargetRevision'] as const) {
      if (canonicalJson(defect[field]) !== canonicalJson(next[field])) throw new Error(`Closure changed immutable defect field: ${field}`);
    }
    reported.delete(defect.id);
    return structuredClone(next);
  });
  for (const defect of reported.values()) {
    if (defect.status !== 'open' && defect.status !== 'reopened') throw new Error('Closure introduced invalid defect');
    merged.push(structuredClone(defect));
  }
  return merged;
}

function validateReviewReport(value: SpecReviewReportV1): void {
  exact(value, ['version','targetRevision','targetSha256','mode','verdict','reviewer','coverage','defects','affectedDefectIds','affectedContracts','closureRequestSha256','acceptedRisks','coverageInvalidated'], 'spec review report');
  if (value.version !== 1) throw new Error('spec review report version is invalid');
  positive(value.targetRevision, 'review target revision'); hash(value.targetSha256, 'review target hash'); actor(value.reviewer, 'reviewer');
  if (!['full','closure'].includes(value.mode) || !['approved','needs-work','rejected'].includes(value.verdict)) throw new Error('spec review mode/verdict is invalid');
  strings(value.coverage, 'review coverage'); strings(value.affectedDefectIds, 'affected defect IDs'); strings(value.affectedContracts, 'affected contracts');
  if (!Array.isArray(value.defects) || !Array.isArray(value.acceptedRisks) || typeof value.coverageInvalidated !== 'boolean') throw new Error('spec review collections are invalid');
  if ((value.mode === 'full') !== (value.closureRequestSha256 === null)) throw new Error('spec review Closure hash is invalid');
  if (value.closureRequestSha256 !== null) hash(value.closureRequestSha256, 'Closure request hash');
  for (const risk of value.acceptedRisks) { exact(risk, ['defectId','rationale','policy','acceptedBy'], 'accepted risk'); text(risk.defectId,'risk defect ID'); text(risk.rationale,'risk rationale'); text(risk.policy,'risk policy'); text(risk.acceptedBy,'risk authority'); }
}

function validateReviewState(value: unknown): asserts value is SpecDeliveryV1['review'] {
  exact(value, ['reviewer','mode','coverage','defects','affectedDefectIds','affectedContracts','closureRequestSha256','acceptedRisks','acceptedReportSha256'], 'spec review state');
  if (value.reviewer !== null) actor(value.reviewer, 'persisted reviewer');
  if (value.mode !== null && !['full','closure'].includes(value.mode)) throw new Error('persisted review mode is invalid');
  strings(value.coverage,'persisted coverage'); strings(value.affectedDefectIds,'persisted affected defect IDs'); strings(value.affectedContracts,'persisted affected contracts');
  if (!Array.isArray(value.defects) || !Array.isArray(value.acceptedRisks)) throw new Error('persisted review collections are invalid');
  if (value.closureRequestSha256 !== null) hash(value.closureRequestSha256,'persisted Closure hash');
  if (value.acceptedReportSha256 !== null) hash(value.acceptedReportSha256,'persisted report hash');
}

function frozenDigest(payload: Omit<FrozenSpecReceiptV1,'receiptSha256'>): string { return digest(`codex-orchestrator-frozen-spec-v1\0${canonicalJson(payload)}`); }
function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function sorted(values: string[]): string[] { return [...new Set(values)].sort(); }
function strings(value: unknown, field: string): asserts value is string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${field} is invalid`); }
function actor(value: unknown, field: string): asserts value is SpecActorV1 { exact(value,['attemptId','sessionId'],field); text(value.attemptId,`${field} attempt ID`); text(value.sessionId,`${field} session ID`); }
function text(value: unknown, field: string): asserts value is string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is invalid`); }
function positive(value: unknown, field: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} is invalid`); }
function hash(value: unknown, field: string): asserts value is string { if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${field} is invalid`); }
function own(value: unknown, key: string): boolean { return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value,key); }
function exact(value: unknown, keys: string[], field: string): asserts value is Record<string, any> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) throw new Error(`${field} has unknown or missing keys`);
}
