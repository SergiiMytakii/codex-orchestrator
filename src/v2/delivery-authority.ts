import { canonicalJson, sha256 } from './containment.js';

export interface DeliveryAuthorityV2 {
  version: 2;
  kind: 'issue';
  issueNumber: number;
  issueUrl: string;
  issueSnapshotSha256: string;
  authorizationLabel: string;
  sourceSha256: string;
  authoritySha256: string;
}

export type DeliveryAuthority = DeliveryAuthorityV2;

export function createIssueDeliveryAuthority(input: {
  issueNumber: number;
  issueUrl: string;
  title: string;
  body: string;
  authorizationLabel: string;
}): DeliveryAuthorityV2 {
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) throw new Error('issue delivery authority number is invalid');
  for (const [field, value] of Object.entries({ issueUrl: input.issueUrl, title: input.title, authorizationLabel: input.authorizationLabel })) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`issue delivery authority ${field} is invalid`);
  }
  if (typeof input.body !== 'string') throw new Error('issue delivery authority body is invalid');
  const issueSnapshotSha256 = sha256(canonicalJson({
    number: input.issueNumber,
    url: input.issueUrl,
    title: input.title,
    body: input.body,
  }));
  const payload = {
    version: 2 as const,
    kind: 'issue' as const,
    issueNumber: input.issueNumber,
    issueUrl: input.issueUrl,
    issueSnapshotSha256,
    authorizationLabel: input.authorizationLabel,
    sourceSha256: issueSnapshotSha256,
  };
  return { ...payload, authoritySha256: authorityHash(payload) };
}

export function validateDeliveryAuthority(value: unknown, input: {
  issueNumber: number;
  issueUrl: string;
  title: string;
  body: string;
  authorizationLabel: string;
}): DeliveryAuthorityV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery authority is invalid');
  const authority = value as Record<string, unknown>;
  const keys = Object.keys(authority).sort().join(',');
  if (keys !== 'authoritySha256,authorizationLabel,issueNumber,issueSnapshotSha256,issueUrl,kind,sourceSha256,version'
    || authority.version !== 2 || authority.kind !== 'issue') throw new Error('delivery authority is invalid');
  const expected = createIssueDeliveryAuthority(input);
  if (canonicalJson(expected) !== canonicalJson(value)) throw new Error('delivery authority binding mismatch');
  return structuredClone(expected);
}

function authorityHash(payload: Omit<DeliveryAuthorityV2, 'authoritySha256'>): string {
  return sha256(`codex-orchestrator-issue-delivery-authority-v2\0${canonicalJson(payload)}`);
}
