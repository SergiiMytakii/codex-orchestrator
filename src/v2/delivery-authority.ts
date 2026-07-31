import { canonicalJson, sha256 } from './containment.js';
import type { RouteReceiptV1 } from './route-decision.js';
import { validateSpecDelivery, type FrozenSpecReceiptV1, type SpecDeliveryV1 } from './spec-delivery.js';

interface DeliveryAuthorityBaseV1 {
  version: 1;
  routeDecisionSha256: string;
  sourceSha256: string;
  authoritySha256: string;
}

export type DeliveryAuthorityV1 =
  | DeliveryAuthorityBaseV1 & { kind: 'direct' }
  | DeliveryAuthorityBaseV1 & {
    kind: 'spec';
    frozenSpec: {
      content: string;
      contentSha256: string;
      revision: number;
      revisionSha256: string;
      approvalReceipt: FrozenSpecReceiptV1;
    };
  };

export function createDirectDeliveryAuthority(receipt: RouteReceiptV1): DeliveryAuthorityV1 {
  if (receipt.route !== 'direct') throw new Error('direct delivery authority requires direct route');
  return withHash({
    version: 1 as const, kind: 'direct' as const,
    routeDecisionSha256: receipt.decisionSha256, sourceSha256: receipt.decisionSha256,
  });
}

export function createSpecDeliveryAuthority(receipt: RouteReceiptV1, spec: SpecDeliveryV1): DeliveryAuthorityV1 {
  if (receipt.route !== 'spec-required') throw new Error('spec delivery authority requires spec route');
  const validated = validateSpecDelivery(spec);
  if (validated.stage !== 'frozen' || !validated.frozen) throw new Error('spec delivery authority requires frozen spec');
  const revision = validated.revisions.at(-1)!;
  const payload = {
    version: 1 as const,
    kind: 'spec' as const,
    routeDecisionSha256: receipt.decisionSha256,
    sourceSha256: validated.frozen.receiptSha256,
    frozenSpec: {
      content: revision.content,
      contentSha256: revision.contentSha256,
      revision: revision.revision,
      revisionSha256: revision.revisionSha256,
      approvalReceipt: structuredClone(validated.frozen),
    },
  };
  return withHash(payload);
}

export function validateDeliveryAuthority(value: unknown, receipt: RouteReceiptV1, spec?: SpecDeliveryV1): DeliveryAuthorityV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery authority is invalid');
  const authority = value as DeliveryAuthorityV1;
  const expectedKeys = authority.kind === 'spec'
    ? 'authoritySha256,frozenSpec,kind,routeDecisionSha256,sourceSha256,version'
    : 'authoritySha256,kind,routeDecisionSha256,sourceSha256,version';
  if (Object.keys(authority).sort().join(',') !== expectedKeys
    || authority.version !== 1 || !['direct', 'spec'].includes(authority.kind)
    || !/^[0-9a-f]{64}$/u.test(authority.routeDecisionSha256)
    || !/^[0-9a-f]{64}$/u.test(authority.sourceSha256)
    || !/^[0-9a-f]{64}$/u.test(authority.authoritySha256)) throw new Error('delivery authority is invalid');
  const expected = receipt.route === 'direct'
    ? createDirectDeliveryAuthority(receipt)
    : spec?.stage === 'frozen' && spec.frozen ? createSpecDeliveryAuthority(receipt, spec) : undefined;
  if (!expected || canonicalJson(expected) !== canonicalJson(authority)) throw new Error('delivery authority binding mismatch');
  return structuredClone(authority);
}

function withHash<T extends Omit<DeliveryAuthorityV1, 'authoritySha256'>>(payload: T): T & { authoritySha256: string } {
  return { ...payload, authoritySha256: sha256(`codex-orchestrator-delivery-authority-v1\0${canonicalJson(payload)}`) };
}
