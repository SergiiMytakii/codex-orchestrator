import {
  decideProofRouting,
  isVisualProofDesirable,
  runnerVisualProofPolicy,
  shouldApplyVisualProofGate,
} from './proof-routing.js';
import type { RunnerValidationLine } from './handoff-evidence.js';

export {
  classifyVisualProofDispatchTarget,
  decideProofRouting,
  isVisualProofDesirable,
  runnerVisualProofPolicy,
  shouldApplyVisualProofGate,
  type ProofRoutingAction,
  type ProofRoutingDecision,
  type VisualProofDispatchTarget,
} from './proof-routing.js';

export function hasPassedValidation(validation: RunnerValidationLine[], patterns: string[]): boolean {
  return validation.some((line) =>
    line.status === 'passed' && patterns.some((pattern) => regexMatches(pattern, validationText(line))),
  );
}

export function hasPassedTddValidation(validation: RunnerValidationLine[], patterns: string[]): boolean {
  if (validation.some((line) => line.status === 'passed' && hasStructuredTddEvidence(line))) {
    return true;
  }

  if (validation.some((line) =>
    line.status === 'passed'
      && !hasMissingTddProofText(validationText(line))
      && patterns.some((pattern) => regexMatches(pattern, validationText(line))),
  )) {
    return true;
  }

  const passedTexts = validation
    .filter((line) => line.status === 'passed')
    .map(validationText)
    .filter((text) => !hasMissingTddProofText(text));
  const hasRedEvidence = passedTexts.some(hasTddRedEvidence);
  const hasGreenEvidence = passedTexts.some(hasTddGreenEvidence);
  return hasRedEvidence && hasGreenEvidence;
}

function hasStructuredTddEvidence(line: RunnerValidationLine): boolean {
  const evidence = line.evidence;
  return evidence?.kind === 'tdd-red-green'
    && evidence.red.status === 'failed'
    && evidence.red.command.trim().length > 0
    && evidence.red.summary.trim().length > 0
    && evidence.green.status === 'passed'
    && evidence.green.command.trim().length > 0
    && evidence.green.summary.trim().length > 0;
}

export function validationText(line: RunnerValidationLine): string {
  return `${line.command}\n${line.summary}`;
}

export function isStrongVisualValidation(line: RunnerValidationLine): boolean {
  return /(Playwright|screenshot|viewport)/iu.test(validationText(line));
}

export function isRunnerVisualValidation(line: RunnerValidationLine): boolean {
  return /runner (?:visual|acceptance) proof/iu.test(validationText(line));
}

export function regexMatches(pattern: string, text: string): boolean {
  return new RegExp(pattern, 'iu').test(text);
}

function hasTddRedEvidence(text: string): boolean {
  return /\bred\s*:/iu.test(text)
    || /\bred\b[\s\S]{0,160}\bfail(?:ed|ing)?\b/iu.test(text)
    || /\bfail(?:ed|ing)?\b[\s\S]{0,160}\bred\b/iu.test(text)
    || /\b(?:test|tests|spec|specs|check|checks)\b[\s\S]{0,120}\bfail(?:ed|ing)?\b/iu.test(text);
}

function hasTddGreenEvidence(text: string): boolean {
  return /\bgreen\s*:/iu.test(text)
    || /\bgreen\b[\s\S]{0,160}\bpass(?:ed|ing)?\b/iu.test(text)
    || /\bpass(?:ed|ing)?\b[\s\S]{0,160}\bgreen\b/iu.test(text)
    || /\b(?:test|tests|spec|specs|check|checks|jest|vitest|playwright|pytest)\b[\s\S]{0,120}\bpass(?:ed|ing)?\b/iu.test(text)
    || /\b(?:flutter|dart|npm|pnpm|yarn)\s+(?:run\s+)?test\b[\s\S]{0,120}\bpass(?:ed|ing)?\b/iu.test(text);
}

function hasMissingTddProofText(text: string): boolean {
  return /\b(?:without|missing|no|lack(?:s|ing)?)\b[\s\S]{0,40}\bred[-\s]?green\b/iu.test(text)
    || /\bred[-\s]?green\b[\s\S]{0,40}\b(?:missing|without|no|lack(?:s|ing)?)\b/iu.test(text);
}
