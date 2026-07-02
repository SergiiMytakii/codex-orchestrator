import type { GitHubIssue } from '../github/issues.js';
import {
  classifyVisualProofDispatchTarget,
  isVisualProofDesirable,
  shouldApplyVisualProofGate,
  type VisualProofDispatchTarget,
} from './review-gate-policy.js';
import { parseBrowserVisualProofArgs, runBrowserVisualProofCommand, type BrowserVisualProofCommandInput } from './browser-visual-proof-command.js';
import { parseMobileVisualProofArgs, runMobileVisualProofCommand, type MobileVisualProofCommandInput } from './mobile-visual-proof-command.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';
import { resolveAcceptanceProofStrategy } from './proof-strategy.js';

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
  const target = classifyVisualProofDispatchTarget({ config: input.config, issue, changedFiles });

  if (target === 'browser') {
    const parsed = parseBrowserVisualProofArgs(input.args, env);
    if (!parsed.ok) throw new Error(parsed.error);
    await (input.browserRunner ?? runBrowserVisualProofCommand)(parsed.value);
    return { target };
  }
  if (target === 'mobile') {
    const parsed = parseMobileVisualProofArgs(input.args, env);
    if (!parsed.ok) throw new Error(parsed.error);
    await (input.mobileRunner ?? runMobileVisualProofCommand)(parsed.value);
    return { target };
  }
  const strategy = resolveAcceptanceProofStrategy({ config: input.config, issue }).strategy;
  if (target === 'none' && (strategy === 'none' || strategy === 'non-visual-smoke')) {
    return { target };
  }
  if (target === 'none'
    && shouldApplyVisualProofGate({ config: input.config, issue, changedFiles })
    && !isVisualProofDesirable({ config: input.config, issue, changedFiles })) {
    return { target };
  }
  throw new Error('visual-proof auto could not select browser or mobile proof from changed files. Provide web/mobile changed paths or use visual-proof browser/mobile explicitly.');
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
