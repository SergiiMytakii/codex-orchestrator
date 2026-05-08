import { readFile } from 'node:fs/promises';

import { validateConfig, type CodexOrchestratorConfig } from '../config/schema.js';
import { projectConfigPath } from '../setup/project-config.js';

export async function readRunnerConfig(targetRoot: string): Promise<CodexOrchestratorConfig> {
  const content = await readFile(projectConfigPath(targetRoot), 'utf8');
  const parsed = JSON.parse(content) as unknown;
  const validation = validateConfig(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid config: ${validation.errors.join('; ')}`);
  }
  return validation.value;
}

export function bulletList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- none'];
}

export function formatSessionTimestamp(now: Date): string {
  return now.toISOString().replace(/\D/g, '').slice(0, 14);
}
