import type { GitHubIssue } from '../github/issues.js';
import {
  decideProofRouting,
  type VisualProofDispatchTarget,
} from './proof-routing.js';
import { parseBrowserVisualProofArgs, runBrowserVisualProofCommand, type BrowserVisualProofCommandInput } from './browser-visual-proof-command.js';
import { parseMobileVisualProofArgs, runMobileVisualProofCommand, type MobileVisualProofCommandInput } from './mobile-visual-proof-command.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { proofPlanModes } from './completion-report.js';

export interface AutoVisualProofCommandInput {
  args: string[];
  config: CodexOrchestratorConfig;
  env?: NodeJS.ProcessEnv;
  browserRunner?: (input: BrowserVisualProofCommandInput) => Promise<unknown>;
  mobileRunner?: (input: MobileVisualProofCommandInput) => Promise<unknown>;
}

export async function runAutoVisualProofCommand(input: AutoVisualProofCommandInput): Promise<{ target: VisualProofDispatchTarget }> {
  const env = input.env ?? process.env;
  const issue = autoIssueFromEnv(env);
  const changedFiles = (env.CODEX_ORCHESTRATOR_CHANGED_FILES ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const plannedTarget = validatedProofPlanTarget(env);
  const routing = plannedTarget !== undefined
    ? {
        action: plannedTarget === 'none' ? 'allow-non-visual' as const : 'dispatch' as const,
        dispatchTarget: plannedTarget,
      }
    : decideProofRouting({ config: input.config, issue, changedFiles });
  const target = routing.dispatchTarget;

  if (routing.action === 'dispatch' && target === 'browser') {
    const parsed = parseBrowserVisualProofArgs(input.args, env);
    if (!parsed.ok) throw new Error(parsed.error);
    await (input.browserRunner ?? runBrowserVisualProofCommand)(parsed.value);
    return { target };
  }
  if (routing.action === 'dispatch' && target === 'mobile') {
    const parsed = parseMobileVisualProofArgs(input.args, env);
    if (!parsed.ok) throw new Error(parsed.error);
    await (input.mobileRunner ?? runMobileVisualProofCommand)(parsed.value);
    return { target };
  }

  if (routing.action === 'skip' || routing.action === 'allow-non-visual') {
    return { target };
  }

  throw new Error('visual-proof auto could not select browser or mobile proof from changed files. Provide web/mobile changed paths or use visual-proof browser/mobile explicitly.');
}

function validatedProofPlanTarget(env: NodeJS.ProcessEnv): VisualProofDispatchTarget | undefined {
  const mode = env.CODEX_ORCHESTRATOR_PROOF_MODE;
  if (!mode) return undefined;
  if (mode === 'browser-visual') return 'browser';
  if (mode === 'mobile-visual') return 'mobile';
  if (proofPlanModes.includes(mode as (typeof proofPlanModes)[number])) return 'none';
  throw new Error(`visual-proof auto received unsupported validated proof mode: ${mode}`);
}

function autoIssueFromEnv(env: NodeJS.ProcessEnv): GitHubIssue {
  const number = Number(env.CODEX_ORCHESTRATOR_ISSUE_NUMBER);
  return {
    number: Number.isInteger(number) && number > 0 ? number : 0,
    title: env.CODEX_ORCHESTRATOR_ISSUE_TITLE ?? '',
    body: env.CODEX_ORCHESTRATOR_ISSUE_BODY ?? '',
    url: '',
    state: 'OPEN',
    labels: [],
    comments: [],
    closedByPullRequestsReferences: [],
  };
}
