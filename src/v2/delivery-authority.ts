import { canonicalJson, sha256 } from './containment.js';
import type { RouteReceiptV1 } from './route-decision.js';
import type { FrozenSpecReceiptV1, SpecDeliveryV1 } from './spec-delivery.js';

export interface DeliveryAuthorityV1 {
  version: 1;
  kind: 'direct' | 'spec';
  routeDecisionSha256: string;
  sourceSha256: string;
  authoritySha256: string;
}

export function createDirectDeliveryAuthority(receipt: RouteReceiptV1): DeliveryAuthorityV1 {
  if (receipt.route !== 'direct') throw new Error('direct delivery authority requires direct route');
  return create('direct', receipt.decisionSha256, receipt.decisionSha256);
}

export function createSpecDeliveryAuthority(receipt: RouteReceiptV1, frozen: FrozenSpecReceiptV1): DeliveryAuthorityV1 {
  if (receipt.route !== 'spec-required') throw new Error('spec delivery authority requires spec route');
  return create('spec', receipt.decisionSha256, frozen.receiptSha256);
}

export function validateDeliveryAuthority(value: unknown, receipt: RouteReceiptV1, spec?: SpecDeliveryV1): DeliveryAuthorityV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery authority is invalid');
  const authority = value as DeliveryAuthorityV1;
  if (Object.keys(authority).sort().join(',') !== 'authoritySha256,kind,routeDecisionSha256,sourceSha256,version'
    || authority.version !== 1 || !['direct', 'spec'].includes(authority.kind)
    || !/^[0-9a-f]{64}$/u.test(authority.routeDecisionSha256)
    || !/^[0-9a-f]{64}$/u.test(authority.sourceSha256)
    || !/^[0-9a-f]{64}$/u.test(authority.authoritySha256)) throw new Error('delivery authority is invalid');
  const expected = receipt.route === 'direct'
    ? createDirectDeliveryAuthority(receipt)
    : spec?.stage === 'frozen' && spec.frozen ? createSpecDeliveryAuthority(receipt, spec.frozen) : undefined;
  if (!expected || canonicalJson(expected) !== canonicalJson(authority)) throw new Error('delivery authority binding mismatch');
  return structuredClone(authority);
}

function create(kind: DeliveryAuthorityV1['kind'], routeDecisionSha256: string, sourceSha256: string): DeliveryAuthorityV1 {
  const payload = { version: 1 as const, kind, routeDecisionSha256, sourceSha256 };
  return { ...payload, authoritySha256: sha256(`codex-orchestrator-delivery-authority-v1\0${canonicalJson(payload)}`) };
}
