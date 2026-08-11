import { posix } from 'node:path';

import { agentReportEnvelopeSchema } from './report-envelope.js';

const MAX_STRING_LENGTH = 16 * 1024;
const MAX_SUMMARY_LENGTH = 4 * 1024;
const MAX_ARRAY_LENGTH = 256;

export interface ExternalBlocker {
  kind: 'credential' | 'tool' | 'service' | 'decision-delta' | 'out-of-scope' | 'authority-boundary';
  summary: string;
  attempted: string[];
  resumable: boolean;
  reviewerRejectionDetail?: string;
}

export interface ImplementationReportV1 {
  version: 1;
  status: 'completed' | 'external-block' | 'answer-only' | 'boundary';
  summary: string;
  changedFiles: string[];
  residualRisks: string[];
  blocker?: ExternalBlocker;
  response?: string;
  boundary?: { kind: 'decision-delta' | 'out-of-scope' | 'authority-boundary' };
}

export function validateImplementationReport(value: unknown): ImplementationReportV1 {
  assertRecord(value, 'implementation report');
  if (value.status === 'completed') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks'], 'implementation report');
  } else if (value.status === 'external-block') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'blocker'], 'implementation report');
  } else if (value.status === 'answer-only') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'response'], 'implementation report');
  } else if (value.status === 'boundary') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'response', 'boundary'], 'implementation report');
  } else {
    throw new Error('implementation report.status is invalid');
  }
  if (value.version !== 1) throw new Error('implementation report.version must be 1');
  assertBoundedString(value.summary, 'implementation report.summary', MAX_SUMMARY_LENGTH, true);
  assertStringArray(value.changedFiles, 'implementation report.changedFiles');
  for (const file of value.changedFiles) assertRelativePath(file, 'implementation report.changedFiles');
  assertUnique(value.changedFiles, 'implementation report.changedFiles');
  assertStringArray(value.residualRisks, 'implementation report.residualRisks');
  if (value.status === 'completed' && value.changedFiles.length === 0) {
    throw new Error('completed implementation report requires changedFiles');
  }
  if ((value.status === 'answer-only' || value.status === 'boundary') && value.changedFiles.length !== 0) {
    throw new Error(`${value.status} implementation report cannot include changedFiles`);
  }
  if (value.status === 'external-block') validateExternalBlocker(value.blocker, 'implementation report.blocker');
  if (value.status === 'answer-only' || value.status === 'boundary') {
    assertBoundedString(value.response, 'implementation report.response', MAX_SUMMARY_LENGTH, true);
  }
  if (value.status === 'boundary') {
    assertRecord(value.boundary, 'implementation report.boundary');
    assertExactObject(value.boundary, ['kind'], 'implementation report.boundary');
    if (!['decision-delta', 'out-of-scope', 'authority-boundary'].includes(value.boundary.kind as string)) {
      throw new Error('implementation report.boundary.kind is invalid');
    }
  }
  return value as unknown as ImplementationReportV1;
}

export function implementationReportOutputSchema(): Record<string, unknown> {
  const commonProperties = {
    version: { type: 'integer', const: 1 },
    summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
    changedFiles: {
      type: 'array',
      maxItems: MAX_ARRAY_LENGTH,
      items: relativePathSchema(),
    },
    residualRisks: stringArraySchema(),
  };
  return agentReportEnvelopeSchema([
      {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks'],
        properties: {
          ...commonProperties,
          status: { type: 'string', const: 'completed' },
          changedFiles: { ...commonProperties.changedFiles, minItems: 1 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'blocker'],
        properties: {
          ...commonProperties,
          status: { type: 'string', const: 'external-block' },
          blocker: externalBlockerSchema(),
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'response'],
        properties: {
          ...commonProperties,
          status: { type: 'string', const: 'answer-only' },
          changedFiles: { ...commonProperties.changedFiles, maxItems: 0 },
          response: boundedStringSchema(MAX_SUMMARY_LENGTH),
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'response', 'boundary'],
        properties: {
          ...commonProperties,
          status: { type: 'string', const: 'boundary' },
          changedFiles: { ...commonProperties.changedFiles, maxItems: 0 },
          response: boundedStringSchema(MAX_SUMMARY_LENGTH),
          boundary: {
            type: 'object', additionalProperties: false, required: ['kind'],
            properties: { kind: { type: 'string', enum: ['decision-delta', 'out-of-scope', 'authority-boundary'] } },
          },
        },
      },
  ]);
}

export function implementationReportRepairDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown validation failure';
  return `Return one complete JSON object matching the supplied implementation output schema. Validation failed: ${detail}`;
}

export function implementationReportSkillExcerpt(): string {
  return 'Complete the work, answer a trusted issue question, state an authority boundary, or report one external blocker. Answer-only and boundary results have no changed files. Return only the JSON object required by the runner-supplied output schema; never publish, push, open a PR, or include credential/path material.';
}

function validateExternalBlocker(value: unknown, field: string): asserts value is ExternalBlocker {
  assertRecord(value, field);
  assertExactObject(value, ['kind', 'summary', 'attempted', 'resumable', ...(hasOwn(value, 'reviewerRejectionDetail') ? ['reviewerRejectionDetail'] : [])], field);
  if (!['credential', 'tool', 'service', 'decision-delta', 'out-of-scope', 'authority-boundary'].includes(value.kind as string)) {
    throw new Error(`${field}.kind is invalid`);
  }
  assertBoundedString(value.summary, `${field}.summary`, MAX_SUMMARY_LENGTH, true);
  assertStringArray(value.attempted, `${field}.attempted`);
  if (typeof value.resumable !== 'boolean') throw new Error(`${field}.resumable is invalid`);
  if (['decision-delta', 'out-of-scope', 'authority-boundary'].includes(value.kind as string) && value.resumable) {
    throw new Error(`${field}.resumable must be false for an authority boundary`);
  }
  if (hasOwn(value, 'reviewerRejectionDetail')) assertBoundedString(value.reviewerRejectionDetail, `${field}.reviewerRejectionDetail`, MAX_SUMMARY_LENGTH, true);
}

function externalBlockerSchema(): Record<string, unknown> {
  const properties = {
    kind: { type: 'string', enum: ['credential', 'tool', 'service', 'decision-delta', 'out-of-scope', 'authority-boundary'] },
    summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
    attempted: stringArraySchema(),
    resumable: { type: 'boolean' },
  };
  return {
    anyOf: [
      { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
      {
        type: 'object',
        additionalProperties: false,
        required: [...Object.keys(properties), 'reviewerRejectionDetail'],
        properties: { ...properties, reviewerRejectionDetail: boundedStringSchema(MAX_SUMMARY_LENGTH) },
      },
    ],
  };
}

function stringArraySchema(): Record<string, unknown> {
  return {
    type: 'array',
    maxItems: MAX_ARRAY_LENGTH,
    items: boundedStringSchema(MAX_STRING_LENGTH),
  };
}

function boundedStringSchema(maxLength: number): Record<string, unknown> {
  return { type: 'string', minLength: 1, maxLength };
}

function relativePathSchema(): Record<string, unknown> {
  return {
    type: 'string',
    minLength: 1,
    maxLength: MAX_STRING_LENGTH,
    pattern: '^[^/\\\\]$|^[^/\\\\][^\\\\]*[^/\\\\]$',
  };
}

function assertRelativePath(value: string, field: string): void {
  if (value.startsWith('/') || value.includes('\\') || posix.normalize(value) !== value) {
    throw new Error(`${field} entries must be normalized repository-relative POSIX paths`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${field} entries must not contain empty, dot, or dot-dot segments`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) throw new Error(`${field} must contain at most 256 strings`);
  for (const item of value) assertBoundedString(item, `${field} entry`, MAX_STRING_LENGTH, true);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function assertBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  requireNonEmpty: boolean,
): asserts value is string {
  if (typeof value !== 'string' || value.length > maxLength || (requireNonEmpty && value.length === 0)) {
    throw new Error(`${field} must be a bounded string`);
  }
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
