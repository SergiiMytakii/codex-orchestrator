export function agentReportEnvelopeSchema(reportSchema: Record<string, unknown> | Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['report'],
    properties: {
      report: Array.isArray(reportSchema) ? { anyOf: reportSchema } : reportSchema,
    },
  };
}

export function unwrapAgentReportEnvelope(value: unknown, nullableFields: string[] = []): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('agent report envelope must be an object');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'report') {
    throw new Error('agent report envelope must contain only report');
  }
  const report = (value as { report: unknown }).report;
  if (nullableFields.length === 0 || typeof report !== 'object' || report === null || Array.isArray(report)) return report;
  const normalized = { ...report } as Record<string, unknown>;
  for (const field of nullableFields) {
    if (normalized[field] === null) delete normalized[field];
  }
  return normalized;
}

export function decodeAgentReportForValidation(bytes: Buffer, nullableFields: string[] = []): unknown {
  const text = bytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(text);
  } catch {
    return text;
  }
  try {
    return unwrapAgentReportEnvelope(parsed, nullableFields);
  } catch {
    return parsed;
  }
}
import { parseJsonWithoutDuplicateKeys } from './containment.js';
