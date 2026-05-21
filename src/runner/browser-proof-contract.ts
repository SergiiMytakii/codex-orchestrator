import { normalizePath } from '../path-policy.js';
import type { AcceptanceProofReport, AcceptanceProofUiEvidence } from './acceptance-proof.js';

export const browserProofScenarioVersion = 1;

export const browserProofRuntimeEnv = {
  proofDir: 'CODEX_ORCHESTRATOR_PROOF_DIR',
  reportPath: 'CODEX_ORCHESTRATOR_PROOF_REPORT_PATH',
  playwrightProfileDir: 'CODEX_ORCHESTRATOR_PLAYWRIGHT_PROFILE_DIR',
  playwrightBrowsersPath: 'PLAYWRIGHT_BROWSERS_PATH',
  browserCacheDir: 'CODEX_ORCHESTRATOR_BROWSER_CACHE_DIR',
  browserExecutablePath: 'CODEX_ORCHESTRATOR_BROWSER_EXECUTABLE_PATH',
} as const;

export type BrowserProofViewportRequiredBy =
  | 'desktop-web-layout'
  | 'mobile-or-responsive'
  | 'issue-specific'
  | 'other';

export interface BrowserProofViewport {
  name: string;
  width: number;
  height: number;
  requiredBy: BrowserProofViewportRequiredBy;
}

export interface BrowserProofCriterion {
  id: string;
  description: string;
}

export interface BrowserProofSourceInputs {
  acceptanceCriteriaRefs: string[];
  implementationEvidenceRefs: string[];
  reproductionSignalRefs?: string[];
  manualQaPlanRefs?: string[];
  runtimeValidationRefs?: string[];
}

export interface BrowserProofAuth {
  mode: 'real-login' | 'seeded-session' | 'not-required' | 'blocked';
  env?: string[];
  shortcutReason?: string;
}

export type BrowserProofStep =
  | { action: 'navigate'; url?: string; path?: string }
  | { action: 'click'; selector?: string; text?: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'press'; selector: string; key: string }
  | { action: 'waitForSelector'; selector: string }
  | { action: 'waitForText'; text: string }
  | { action: 'assertText'; text: string; selector?: string }
  | { action: 'assertUrl'; expected: string }
  | BrowserProofCheckpointStep;

export type BrowserProofCheckpointKind = 'screenshot' | 'domSnapshot';

export interface BrowserProofCheckpointStep {
  action: BrowserProofCheckpointKind;
  checkpointId: string;
  path: string;
  viewportName: string;
  criteriaRefs: string[];
}

export interface BrowserProofScenario {
  version: 1;
  baseUrl: string;
  viewports: BrowserProofViewport[];
  criteria: BrowserProofCriterion[];
  sourceInputs: BrowserProofSourceInputs;
  auth?: BrowserProofAuth;
  steps: BrowserProofStep[];
}

export type BrowserProofRuntimeIssueKind =
  | 'invalidScenario'
  | 'playwrightPackage'
  | 'browserBinary'
  | 'cacheDir'
  | 'profileDir'
  | 'consoleErrors'
  | 'networkFailures';

export interface BrowserProofRuntimeIssue {
  kind: BrowserProofRuntimeIssueKind;
  diagnostic: string;
  requiredChanges: string[];
}

export interface BrowserProofCheckpointEvidence {
  checkpointId: string;
  kind: BrowserProofCheckpointKind;
  path: string;
  viewportName: string;
  criteriaRefs: string[];
  description: string;
}

export interface BrowserProofDiagnostics {
  consoleLogPath?: string;
  networkLogPath?: string;
  runSummaryPath?: string;
}

export function validateBrowserProofScenario(
  input: unknown,
  options: { artifactDir: string; issueNumber: number; envPassthrough: string[] },
): { ok: true; scenario: BrowserProofScenario } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const record = objectRecord(input);
  if (!record) {
    return { ok: false, errors: ['scenario must be an object'] };
  }

  if (record.version !== browserProofScenarioVersion) {
    errors.push('version must be 1');
  }
  validateHttpUrl(record.baseUrl, 'baseUrl', errors);
  validateViewports(record.viewports, errors);
  validateCriteria(record.criteria, errors);
  validateSourceInputs(record.sourceInputs, errors);
  validateAuth(record.auth, options.envPassthrough, errors);
  validateSteps(record.steps, record.criteria, options, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, scenario: input as BrowserProofScenario };
}

export function assembleBlockedBrowserProofReport(input: {
  issueNumber: number;
  artifactDir: string;
  scenario?: BrowserProofScenario;
  issue: BrowserProofRuntimeIssue;
  diagnostics?: BrowserProofDiagnostics;
}): AcceptanceProofReport {
  const diagnosticPath = proofArtifactPath(input.artifactDir, input.issueNumber, 'browser-proof-diagnostics.json');
  const diagnosticArtifactRefs = [
    diagnosticPath,
    ...diagnosticArtifacts(input.diagnostics ?? {}, input.artifactDir, input.issueNumber)
      .map((artifact) => artifact.path)
      .filter((path): path is string => Boolean(path)),
  ];
  const criteria = input.scenario?.criteria.length
    ? input.scenario.criteria
    : [{ id: 'browser-proof-runtime', description: 'Browser proof runtime is available before launch.' }];
  return {
    status: 'blocked',
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      status: 'unknown',
      confidence: 'low',
      reasoningSummary: input.issue.diagnostic,
      artifactRefs: diagnosticArtifactRefs,
    })),
    artifacts: [
      {
        type: 'log',
        path: diagnosticPath,
        description: `Browser proof blocked before launch: ${input.issue.kind}`,
      },
      ...diagnosticArtifacts(input.diagnostics ?? {}, input.artifactDir, input.issueNumber),
    ],
    proofPhaseDiff: {
      allowedProofPaths: diagnosticArtifactRefs,
      forbiddenProductPaths: [],
    },
    reworkRequest: {
      summary: `Browser proof blocked before launch: ${input.issue.kind}`,
      requiredChanges: input.issue.requiredChanges,
      evidenceRefs: diagnosticArtifactRefs,
    },
    residualRisks: [],
  };
}

export function assembleBrowserAcceptanceProofReport(input: {
  issueNumber: number;
  artifactDir: string;
  scenario: BrowserProofScenario;
  checkpoints: BrowserProofCheckpointEvidence[];
  diagnostics: BrowserProofDiagnostics;
  workflow: {
    entrypoint: string;
    path: string[];
    screenState: string;
  };
  layoutFindings: string[];
  copyFindings: string[];
}): AcceptanceProofReport {
  const artifacts = [
    ...input.checkpoints.map((checkpoint) => ({
      type: checkpoint.kind === 'screenshot' ? 'screenshot' as const : 'ui-dump' as const,
      path: assertProofArtifactPath(checkpoint.path, input.artifactDir, input.issueNumber),
      description: checkpoint.description,
    })),
    ...diagnosticArtifacts(input.diagnostics, input.artifactDir, input.issueNumber),
  ];
  const artifactRefsByCriterion = new Map<string, string[]>();
  for (const checkpoint of input.checkpoints) {
    const path = assertProofArtifactPath(checkpoint.path, input.artifactDir, input.issueNumber);
    for (const criterionRef of checkpoint.criteriaRefs) {
      artifactRefsByCriterion.set(criterionRef, [...(artifactRefsByCriterion.get(criterionRef) ?? []), path]);
    }
  }
  const currentArtifactRefs = artifacts.map((artifact) => artifact.path).filter((path): path is string => Boolean(path));
  return {
    status: 'passed',
    criteria: input.scenario.criteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      status: 'passed',
      confidence: 'high',
      reasoningSummary: 'Browser proof scenario reached the mapped checkpoint evidence.',
      artifactRefs: artifactRefsByCriterion.get(criterion.id) ?? [],
    })),
    artifacts,
    uiEvidence: assembleUiEvidence(input, currentArtifactRefs),
    proofPhaseDiff: {
      allowedProofPaths: currentArtifactRefs,
      forbiddenProductPaths: [],
    },
    residualRisks: [],
  };
}

function assembleUiEvidence(
  input: Parameters<typeof assembleBrowserAcceptanceProofReport>[0],
  currentArtifactRefs: string[],
): AcceptanceProofUiEvidence {
  return {
    workflowScope: {
      entrypoint: input.workflow.entrypoint,
      path: input.workflow.path,
      screenState: input.workflow.screenState,
      authPath: input.scenario.auth?.mode ?? 'not-required',
      authShortcutReason: input.scenario.auth?.mode === 'seeded-session' ? input.scenario.auth.shortcutReason : undefined,
    },
    viewportCoverage: input.scenario.viewports.map((viewport) => ({
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      requiredBy: viewport.requiredBy,
      artifactRefs: input.checkpoints
        .filter((checkpoint) => checkpoint.viewportName === viewport.name)
        .map((checkpoint) => assertProofArtifactPath(checkpoint.path, input.artifactDir, input.issueNumber)),
    })),
    artifactFreshness: {
      currentArtifactRefs,
      checkedAfterFinalRun: true,
    },
    layoutReview: {
      checked: true,
      findings: input.layoutFindings.map((summary) => ({ summary, artifactRefs: currentArtifactRefs })),
    },
    copyReview: {
      checked: true,
      findings: input.copyFindings.map((summary) => ({ summary, artifactRefs: currentArtifactRefs })),
    },
    sourceInputs: input.scenario.sourceInputs,
  };
}

function diagnosticArtifacts(
  diagnostics: BrowserProofDiagnostics,
  artifactDir: string,
  issueNumber: number,
): AcceptanceProofReport['artifacts'] {
  const artifacts: AcceptanceProofReport['artifacts'] = [];
  if (diagnostics.consoleLogPath) {
    artifacts.push({
      type: 'log',
      path: assertProofArtifactPath(diagnostics.consoleLogPath, artifactDir, issueNumber),
      description: 'Browser console log',
    });
  }
  if (diagnostics.networkLogPath) {
    artifacts.push({
      type: 'log',
      path: assertProofArtifactPath(diagnostics.networkLogPath, artifactDir, issueNumber),
      description: 'Browser failed network request log',
    });
  }
  if (diagnostics.runSummaryPath) {
    artifacts.push({
      type: 'other',
      path: assertProofArtifactPath(diagnostics.runSummaryPath, artifactDir, issueNumber),
      description: 'Browser proof run summary',
    });
  }
  return artifacts;
}

function validateViewports(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('viewports must be a non-empty array');
    return;
  }
  const requiredByValues: BrowserProofViewportRequiredBy[] = ['desktop-web-layout', 'mobile-or-responsive', 'issue-specific', 'other'];
  for (const [index, viewport] of value.entries()) {
    const record = objectRecord(viewport);
    if (!record) {
      errors.push(`viewport[${index}] must be an object`);
      continue;
    }
    if (!nonEmptyString(record.name)) errors.push(`viewport[${index}].name is required`);
    if (!positiveInteger(record.width) || !positiveInteger(record.height)) {
      errors.push(`viewport[${index}] must include positive integer width and height`);
    }
    if (!requiredByValues.includes(record.requiredBy as BrowserProofViewportRequiredBy)) {
      errors.push(`viewport[${index}].requiredBy is invalid`);
    }
  }
}

function validateCriteria(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('criteria must be a non-empty array');
    return;
  }
  for (const [index, criterion] of value.entries()) {
    const record = objectRecord(criterion);
    if (!record) {
      errors.push(`criteria[${index}] must be an object`);
      continue;
    }
    if (!nonEmptyString(record.id)) errors.push(`criteria[${index}].id is required`);
    if (!nonEmptyString(record.description)) errors.push(`criteria[${index}].description is required`);
  }
}

function validateSourceInputs(value: unknown, errors: string[]): void {
  const record = objectRecord(value);
  if (!record) {
    errors.push('sourceInputs is required');
    return;
  }
  if (!nonEmptyStringArray(record.acceptanceCriteriaRefs)) {
    errors.push('sourceInputs.acceptanceCriteriaRefs must be non-empty');
  }
  if (!nonEmptyStringArray(record.implementationEvidenceRefs)) {
    errors.push('sourceInputs.implementationEvidenceRefs must be non-empty');
  }
}

function validateAuth(value: unknown, envPassthrough: string[], errors: string[]): void {
  if (value === undefined) return;
  const record = objectRecord(value);
  if (!record) {
    errors.push('auth must be an object');
    return;
  }
  if (!['real-login', 'seeded-session', 'not-required', 'blocked'].includes(String(record.mode))) {
    errors.push('auth.mode is invalid');
  }
  if (record.mode === 'seeded-session' && !nonEmptyString(record.shortcutReason)) {
    errors.push('seeded-session auth requires shortcutReason');
  }
  if (record.env !== undefined) {
    if (!Array.isArray(record.env)) {
      errors.push('auth env must be an array');
      return;
    }
    for (const envName of record.env) {
      if (typeof envName !== 'string' || /(?:^|\/)\.env(?:\.|$)/u.test(envName)) {
        errors.push(`auth env references a secret file: ${String(envName)}`);
      } else if (!/^[A-Z_][A-Z0-9_]*$/u.test(envName)) {
        errors.push(`auth env name is invalid: ${envName}`);
      } else if (!envPassthrough.includes(envName)) {
        errors.push(`auth env is not configured for passthrough: ${envName}`);
      }
    }
  }
}

function validateSteps(
  value: unknown,
  criteriaValue: unknown,
  options: { artifactDir: string; issueNumber: number },
  errors: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('steps must be a non-empty array');
    return;
  }
  const criterionIds = new Set(Array.isArray(criteriaValue)
    ? criteriaValue.map((criterion) => objectRecord(criterion)?.id).filter((id): id is string => typeof id === 'string')
    : []);
  const mappedCriteria = new Set<string>();
  for (const [index, step] of value.entries()) {
    const record = objectRecord(step);
    if (!record) {
      errors.push(`step[${index}] must be an object`);
      continue;
    }
    validateStep(record, index, criterionIds, mappedCriteria, options, errors);
  }
  for (const id of criterionIds) {
    if (!mappedCriteria.has(id)) {
      errors.push(`criteria ${id} must be mapped to at least one checkpoint`);
    }
  }
}

function validateStep(
  record: Record<string, unknown>,
  index: number,
  criterionIds: Set<string>,
  mappedCriteria: Set<string>,
  options: { artifactDir: string; issueNumber: number },
  errors: string[],
): void {
  switch (record.action) {
    case 'navigate':
      if (nonEmptyString(record.url) === nonEmptyString(record.path)) errors.push(`navigate step[${index}] requires exactly one of url or path`);
      if (nonEmptyString(record.url)) validateHttpUrl(record.url, `step[${index}].url`, errors);
      if (nonEmptyString(record.path) && !String(record.path).startsWith('/')) errors.push(`step[${index}].path must start with /`);
      return;
    case 'click':
      if (nonEmptyString(record.selector) === nonEmptyString(record.text)) errors.push(`click step[${index}] requires exactly one of selector or text`);
      return;
    case 'fill':
      if (!nonEmptyString(record.selector) || !nonEmptyString(record.value)) errors.push(`fill step[${index}] requires selector and value`);
      return;
    case 'press':
      if (!nonEmptyString(record.selector) || !nonEmptyString(record.key)) errors.push(`press step[${index}] requires selector and key`);
      return;
    case 'waitForSelector':
      if (!nonEmptyString(record.selector)) errors.push(`waitForSelector step[${index}] requires selector`);
      return;
    case 'waitForText':
      if (!nonEmptyString(record.text)) errors.push(`waitForText step[${index}] requires text`);
      return;
    case 'assertText':
      if (!nonEmptyString(record.text)) errors.push(`assertText step[${index}] requires text`);
      return;
    case 'assertUrl':
      if (!nonEmptyString(record.expected)) errors.push(`assertUrl step[${index}] requires expected`);
      return;
    case 'screenshot':
    case 'domSnapshot':
      validateCheckpoint(record, index, criterionIds, mappedCriteria, options, errors);
      return;
    default:
      errors.push(`unknown action at step[${index}]: ${String(record.action)}`);
  }
}

function validateCheckpoint(
  record: Record<string, unknown>,
  index: number,
  criterionIds: Set<string>,
  mappedCriteria: Set<string>,
  options: { artifactDir: string; issueNumber: number },
  errors: string[],
): void {
  if (!nonEmptyString(record.checkpointId)) errors.push(`checkpoint step[${index}] requires checkpointId`);
  if (!nonEmptyString(record.viewportName)) errors.push(`checkpoint step[${index}] requires viewportName`);
  if (!nonEmptyString(record.path)) {
    errors.push(`checkpoint step[${index}] requires path`);
  } else {
    try {
      assertProofArtifactPath(record.path, options.artifactDir, options.issueNumber);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `checkpoint step[${index}] has invalid path`);
    }
  }
  if (!nonEmptyStringArray(record.criteriaRefs)) {
    errors.push(`checkpoint step[${index}] requires criteriaRefs`);
    return;
  }
  for (const ref of record.criteriaRefs as string[]) {
    if (!criterionIds.has(ref)) {
      errors.push(`checkpoint step[${index}] references unknown criteria ${ref}`);
    } else {
      mappedCriteria.add(ref);
    }
  }
}

export function assertBrowserProofArtifactPath(path: string, artifactDir: string, issueNumber: number): string {
  const normalized = normalizePath(path);
  const prefix = proofArtifactPath(artifactDir, issueNumber, '');
  if (
    normalized.startsWith('/')
    || normalized.includes('../')
    || normalized === '..'
    || !normalized.startsWith(prefix)
    || normalized.startsWith(`${prefix}playwright-profile/`)
    || normalized.startsWith(`${prefix}ms-playwright/`)
  ) {
    throw new Error(`Invalid browser proof artifact path: ${path}`);
  }
  return normalized;
}

export function browserProofArtifactPath(artifactDir: string, issueNumber: number, leaf: string): string {
  return proofArtifactPath(artifactDir, issueNumber, leaf);
}

function assertProofArtifactPath(path: string, artifactDir: string, issueNumber: number): string {
  return assertBrowserProofArtifactPath(path, artifactDir, issueNumber);
}

function proofArtifactPath(artifactDir: string, issueNumber: number, leaf: string): string {
  const prefix = `${normalizePath(artifactDir).replace(/\/+$/u, '')}/issue-${issueNumber}/`;
  return `${prefix}${leaf}`;
}

function validateHttpUrl(value: unknown, path: string, errors: string[]): void {
  if (!nonEmptyString(value)) {
    errors.push(`${path} must be an absolute http/https URL`);
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`${path} must be an absolute http/https URL`);
    }
  } catch {
    errors.push(`${path} must be an absolute http/https URL`);
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}
