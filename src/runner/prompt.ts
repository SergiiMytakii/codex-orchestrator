import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { codexRuntimeTurnText } from '../codex/execution-adapter.js';
import type { CodexOrchestratorConfig } from '../config/schema.js';

export async function writeDurablePrompt(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId: string;
  contextArtifactPath: string;
}): Promise<string> {
  const path = sessionPromptPath(input);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, codexRuntimeTurnText(input.contextArtifactPath) + '\n', 'utf8');
  return path;
}

export function sessionPromptPath(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId: string;
}): string {
  return join(
    input.targetRoot,
    input.config.runner.stateDir,
    'prompts',
    'issue-' + input.issueNumber + '-' + input.sessionId + '.md',
  );
}

export function sessionReportPath(input: {
  targetRoot: string;
  config: CodexOrchestratorConfig;
  issueNumber: number;
  sessionId: string;
}): string {
  return join(
    input.targetRoot,
    input.config.runner.stateDir,
    'reports',
    'issue-' + input.issueNumber + '-' + input.sessionId + '.json',
  );
}
