import type { MissionOwnershipMode } from './mission-ownership.js';
import {
  classifyMissionCheck,
  type RunnerOwnedMissionCheck,
} from './mission-check-policy.js';

export interface MissionActivationInput {
  mode: MissionOwnershipMode;
  requiredCompatibilityEpoch: number;
  deploymentCompatibilityEpoch: number;
  ownerCompatibilityEpoch: number;
  ownerDeploymentMatches: boolean;
  preFenceDaemonIds: string[];
  dedicatedCredential: boolean;
  configuredChecks?: Record<string, string | RunnerOwnedMissionCheck>;
}

export type MissionActivationDecision =
  | { kind: 'legacy-only' }
  | { kind: 'shadow-only' }
  | { kind: 'mission-enabled'; legacyCheckNames: string[] }
  | { kind: 'external-input-required'; reason: string; evidence: string[] }
  | { kind: 'safety-stop'; reason: string };

export function evaluateMissionActivation(input: MissionActivationInput): MissionActivationDecision {
  if (input.mode === 'off') {
    return { kind: 'legacy-only' };
  }
  if (input.mode === 'shadow') {
    return { kind: 'shadow-only' };
  }
  assertEpoch(input.requiredCompatibilityEpoch, 'requiredCompatibilityEpoch');
  assertEpoch(input.deploymentCompatibilityEpoch, 'deploymentCompatibilityEpoch');
  assertEpoch(input.ownerCompatibilityEpoch, 'ownerCompatibilityEpoch');

  const oldDaemons = [...new Set(input.preFenceDaemonIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (oldDaemons.length > 0) {
    return {
      kind: 'external-input-required',
      reason: 'pre-fence-daemons-present',
      evidence: oldDaemons,
    };
  }
  if (!input.dedicatedCredential) {
    return {
      kind: 'external-input-required',
      reason: 'dedicated-credential-required',
      evidence: [],
    };
  }
  if (input.deploymentCompatibilityEpoch < input.requiredCompatibilityEpoch
    || input.ownerCompatibilityEpoch < input.requiredCompatibilityEpoch) {
    return {
      kind: 'external-input-required',
      reason: 'compatibility-fence-not-installed',
      evidence: [
        `required=${input.requiredCompatibilityEpoch}`,
        `deployment=${input.deploymentCompatibilityEpoch}`,
        `owner=${input.ownerCompatibilityEpoch}`,
      ],
    };
  }
  if (!input.ownerDeploymentMatches
    || input.ownerCompatibilityEpoch !== input.deploymentCompatibilityEpoch) {
    return { kind: 'safety-stop', reason: 'runtime-owner-deployment-mismatch' };
  }
  const legacyCheckNames = Object.entries(input.configuredChecks ?? {})
    .filter(([, check]) => classifyMissionCheck(check).kind === 'legacy-shell')
    .map(([name]) => name)
    .sort();
  return { kind: 'mission-enabled', legacyCheckNames };
}

function assertEpoch(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Mission activation ${field} must be a positive integer.`);
  }
}
