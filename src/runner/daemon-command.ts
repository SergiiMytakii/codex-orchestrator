import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

import { GhCliIssueAdapter } from '../github/gh-issue-adapter.js';
import type { GitHubIssueAdapter } from '../github/issues.js';
import { readRunnerConfig } from './command-utils.js';
import { discoverIssueWork, type IssueDiscoveryDecision } from './issue-state-machine.js';
import { runPlanAutoCommand } from './plan-auto-command.js';
import { runScopedAutoCommand } from './scoped-auto-command.js';

export interface DaemonCommandOptions {
  targetRoot: string;
  issueAdapter?: GitHubIssueAdapter;
  intervalMs?: number;
  once?: boolean;
  maxRuns?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  executeIssue?: (issueNumber: number) => Promise<{ reportComment: string }>;
  onEvent?: (line: string) => void;
  now?: () => Date;
}

export interface DaemonCommandResult {
  output: string;
  scanned: number;
  executed: number[];
}

const defaultIntervalMs = 300_000;

export async function runDaemonCommand(options: DaemonCommandOptions): Promise<DaemonCommandResult> {
  const targetRoot = resolve(options.targetRoot);
  const config = await readRunnerConfig(targetRoot);
  const adapter = options.issueAdapter ?? new GhCliIssueAdapter(config.github.owner, config.github.repo);
  const intervalMs = options.intervalMs ?? defaultIntervalMs;
  const once = options.once ?? false;
  const maxRuns = options.maxRuns;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? (() => new Date());
  const lines: string[] = [];
  const executed: number[] = [];
  let scanned = 0;

  const emit = (line: string): void => {
    lines.push(line);
    options.onEvent?.(line);
  };

  emit('codex-orchestrator daemon');
  emit(`repo: ${config.github.owner}/${config.github.repo}`);
  emit(`target: ${targetRoot}`);
  emit(`intervalMs: ${intervalMs}`);

  while (true) {
    scanned += 1;
    const decision = await findNextEligibleIssue(adapter, config);

    if (!decision) {
      emit(`[${now().toISOString()}] no eligible issues`);
    } else {
      emit(`[${now().toISOString()}] running #${decision.issueNumber} ${decision.mode}`);
      try {
        const executeIssue = options.executeIssue ?? ((issueNumber) => runIssue(targetRoot, issueNumber, decision.mode));
        await executeIssue(decision.issueNumber);
        executed.push(decision.issueNumber);
        emit(`[${now().toISOString()}] completed #${decision.issueNumber}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'issue execution failed';
        emit(`[${now().toISOString()}] failed #${decision.issueNumber}: ${message}`);
      }
    }

    if (once || (maxRuns !== undefined && executed.length >= maxRuns)) {
      break;
    }

    await wait(intervalMs);
  }

  return { output: lines.join('\n'), scanned, executed };
}

async function findNextEligibleIssue(
  adapter: GitHubIssueAdapter,
  config: Awaited<ReturnType<typeof readRunnerConfig>>,
): Promise<Extract<IssueDiscoveryDecision, { kind: 'eligible' }> | undefined> {
  const discoveryLabels = [
    config.github.labels.auto.name,
    config.github.labels.planAuto.name,
    config.github.labels.manual.name,
    config.github.labels.blocked.name,
    config.github.labels.running.name,
    config.github.labels.review.name,
  ];
  const issues = await adapter.listOpenIssuesWithAnyLabel(discoveryLabels);
  return discoverIssueWork(issues, config).find(
    (decision): decision is Extract<IssueDiscoveryDecision, { kind: 'eligible' }> => decision.kind === 'eligible',
  );
}

function runIssue(
  targetRoot: string,
  issueNumber: number,
  mode: Extract<IssueDiscoveryDecision, { kind: 'eligible' }>['mode'],
): Promise<{ reportComment: string }> {
  if (mode === 'plan-parent') {
    return runPlanAutoCommand({ targetRoot, issueNumber });
  }
  return runScopedAutoCommand({ targetRoot, issueNumber });
}
