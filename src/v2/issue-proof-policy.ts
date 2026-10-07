import { containsCredentialEvidence } from './containment.js';

export type AndroidProofStep = { action: 'tap' | 'expect'; text: string } | { action: 'back' } | { action: 'swipe'; direction: 'up' | 'down' };
export interface IssueProofRequirements {
  version: 1;
  level: 'tests-only' | 'android-live';
  reason: string;
  authentication: 'none' | 'dev-account';
  steps: AndroidProofStep[];
}

/** Read one explicit proof contract from the frozen issue, preserving legacy issues without it. */
export function readIssueProofRequirements(body: string): IssueProofRequirements | undefined {
  const lines = body.split(/\r?\n/u);
  let fenced = false;
  const headings: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^```/u.test(line.trim())) fenced = !fenced;
    else if (!fenced && /^## Proof requirements\s*$/u.test(line)) headings.push(index);
  }
  if (!headings.length) return undefined;
  if (headings.length !== 1) throw new Error('Issue must have one Proof requirements section.');
  const start = headings[0]! + 1;
  if (lines[start]?.trim() !== '```json') throw new Error('Proof requirements must be a JSON block.');
  const end = lines.findIndex((line, index) => index > start && line.trim() === '```');
  if (end < 0) throw new Error('Proof requirements block is incomplete.');
  return validateIssueProofRequirements(JSON.parse(lines.slice(start + 1, end).join('\n')));
}

/** Validate bounded device actions and reject an ambiguous or credential-bearing contract. */
export function validateIssueProofRequirements(value: unknown): IssueProofRequirements {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'authentication,level,reason,steps,version'
    || value.version !== 1 || !['tests-only', 'android-live'].includes(String(value.level))
    || !['none', 'dev-account'].includes(String(value.authentication)) || !text(value.reason)
    || !Array.isArray(value.steps) || value.steps.length > 32 || containsCredentialEvidence(JSON.stringify(value))) {
    throw new Error('Proof requirements are invalid.');
  }
  if (value.level === 'tests-only') {
    if (value.authentication !== 'none' || value.steps.length) throw new Error('Tests-only proof cannot require a device or login.');
  } else {
    const last = value.steps.at(-1);
    if (!value.steps.length || !record(last) || last.action !== 'expect') {
      throw new Error('Live Android proof requires steps ending with an observable expectation.');
    }
  }
  for (const step of value.steps) {
    if (!record(step)) throw new Error('Android proof step is invalid.');
    const keys = Object.keys(step).sort().join(',');
    if ((step.action === 'tap' || step.action === 'expect') && keys === 'action,text' && text(step.text)) continue;
    if (step.action === 'back' && keys === 'action') continue;
    if (step.action === 'swipe' && keys === 'action,direction' && ['up', 'down'].includes(String(step.direction))) continue;
    throw new Error('Android proof step is invalid.');
  }
  return value as unknown as IssueProofRequirements;
}

/** Recognize JSON objects without accepting arrays. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Bound labels and rationale to one non-empty line. */
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024 && !/[\r\n]/u.test(value);
}
