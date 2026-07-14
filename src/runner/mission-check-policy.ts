import {
  authorizeMissionCapability,
  missionGitStatusArgv,
  type MissionCapability,
} from './mission-capability-kernel.js';

export interface RunnerOwnedMissionCheck {
  executable: string;
  args: string[];
  capability: MissionCapability;
}

export type MissionCheckClassification =
  | { kind: 'legacy-shell'; reason: 'string-command-has-no-enforced-argv-contract' }
  | {
      kind: 'safe-runner-argv';
      executable: string;
      args: string[];
      capability: MissionCapability;
    };

export function classifyMissionCheck(
  check: string | RunnerOwnedMissionCheck,
): MissionCheckClassification {
  if (typeof check === 'string') {
    return {
      kind: 'legacy-shell',
      reason: 'string-command-has-no-enforced-argv-contract',
    };
  }
  authorizeMissionCapability({
    missionId: 'classification-probe',
    actionKey: 'classification-probe',
    capability: check.capability,
    argv: [],
    requestedPaths: ['**'],
    grantedPaths: ['**'],
    inputSnapshot: 'classification-probe',
    fencingEpoch: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  if (check.capability !== 'git-status'
    || [check.executable, ...check.args].join('\0') !== missionGitStatusArgv.join('\0')) {
    throw new Error(`Mission capability ${check.capability} requires allowlisted argv.`);
  }
  return {
    kind: 'safe-runner-argv',
    executable: check.executable,
    args: [...check.args],
    capability: check.capability,
  };
}
