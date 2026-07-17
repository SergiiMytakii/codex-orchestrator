import { canonicalJson } from './containment.js';
import type { SetupIntent, SetupOutcome } from './setup.js';

export function parseSetupArgs(argv: string[]): SetupIntent {
  const [command, ...args] = argv;
  if (command !== 'setup' && command !== 'doctor' && command !== 'status') throw new Error('operational command is invalid');
  const values = new Map<string, string | true>();
  const valueFlags = new Set(['--target', '--github-owner', '--github-repo']);
  const booleanFlags = new Set(['--dry-run', '--prepare-labels', '--fresh']);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (values.has(flag)) throw new Error('operational flag is duplicated');
    if (booleanFlags.has(flag)) { values.set(flag, true); continue; }
    if (!valueFlags.has(flag)) throw new Error('operational flag is unknown');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('operational flag value is missing');
    values.set(flag, value);
  }
  const targetRoot = values.get('--target');
  if (typeof targetRoot !== 'string' || !targetRoot.startsWith('/')) throw new Error('absolute target is required');
  const owner = values.get('--github-owner');
  const repo = values.get('--github-repo');
  if ((owner === undefined) !== (repo === undefined)) throw new Error('repository override must be complete');
  if (command !== 'setup' && (values.size !== 1 || owner !== undefined || values.has('--dry-run'))) {
    throw new Error('doctor and status accept only target');
  }
  if (values.has('--fresh') && values.has('--prepare-labels')) throw new Error('setup operation flags are ambiguous');
  const operation = command === 'doctor' || command === 'status'
    ? command
    : values.has('--fresh')
      ? 'fresh'
      : values.has('--prepare-labels')
        ? 'prepare-labels'
        : 'configure';
  return {
    targetRoot,
    operation,
    dryRun: values.has('--dry-run'),
    ...(typeof owner === 'string' && typeof repo === 'string' ? { repository: { owner, repo } } : {}),
  };
}

export function setupOutcomeExitCode(outcome: SetupOutcome): 0 | 20 | 70 {
  switch (outcome.status) {
    case 'created':
    case 'unchanged':
    case 'labels-prepared':
    case 'fresh-reset':
    case 'migrated':
    case 'planned':
      return 0;
    case 'inspected':
      return outcome.disposition === 'ok' ? 0 : 20;
    case 'legacy-detected':
    case 'blocked-active':
    case 'repository-mismatch':
    case 'unsupported-schema':
    case 'labels-partial':
      return 20;
    case 'transport-failed':
    case 'io-failed':
      return 70;
    default:
      return assertNever(outcome);
  }
}

export function renderSetupResultJson(outcome: SetupOutcome): string {
  return `${canonicalJson({
    schema: 'codex-orchestrator.agent-auto-setup-result',
    version: 1,
    result: structuredClone(outcome),
  })}\n`;
}

function assertNever(value: never): never {
  throw new Error(`unmapped Setup outcome: ${String(value)}`);
}
