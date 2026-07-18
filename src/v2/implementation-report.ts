import { posix } from 'node:path';

import { agentReportEnvelopeSchema } from './report-envelope.js';

const MAX_STRING_LENGTH = 16 * 1024;
const MAX_SUMMARY_LENGTH = 4 * 1024;
const MAX_ARRAY_LENGTH = 256;

export interface ExternalBlocker {
  kind: 'credential' | 'tool' | 'service' | 'product-decision';
  summary: string;
  attempted: string[];
}

export interface ImplementationReportV1 {
  version: 1;
  status: 'completed' | 'external-block';
  summary: string;
  changedFiles: string[];
  residualRisks: string[];
  blocker?: ExternalBlocker;
}

export function validateImplementationReport(value: unknown): ImplementationReportV1 {
  assertRecord(value, 'implementation report');
  if (value.status === 'completed') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks'], 'implementation report');
  } else if (value.status === 'external-block') {
    assertExactObject(value, ['version', 'status', 'summary', 'changedFiles', 'residualRisks', 'blocker'], 'implementation report');
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
  if (value.status === 'external-block') validateExternalBlocker(value.blocker, 'implementation report.blocker');
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
  ]);
}

export function implementationReportRepairDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown validation failure';
  return `Return one complete JSON object matching the supplied implementation output schema. Validation failed: ${detail}`;
}

export function implementationReportSkillExcerpt(): string {
  return 'Complete the work or report one external blocker. Return only the JSON object required by the runner-supplied output schema; never publish, push, open a PR, or include credential/path material.';
}

function validateExternalBlocker(value: unknown, field: string): asserts value is ExternalBlocker {
  assertExactObject(value, ['kind', 'summary', 'attempted'], field);
  if (!['credential', 'tool', 'service', 'product-decision'].includes(value.kind as string)) {
    throw new Error(`${field}.kind is invalid`);
  }
  assertBoundedString(value.summary, `${field}.summary`, MAX_SUMMARY_LENGTH, true);
  assertStringArray(value.attempted, `${field}.attempted`);
}

function externalBlockerSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'summary', 'attempted'],
    properties: {
      kind: { type: 'string', enum: ['credential', 'tool', 'service', 'product-decision'] },
      summary: boundedStringSchema(MAX_SUMMARY_LENGTH),
      attempted: stringArraySchema(),
    },
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

function assertExactObject(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
  assertRecord(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has unknown or missing keys`);
  }
}
