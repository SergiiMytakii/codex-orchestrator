import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { LabelDefinition } from '../config/schema.js';
import type { GitHubLabelAdapter } from './labels.js';

const execFileAsync = promisify(execFile);

export type CommandExecutor = (
  file: string,
  args: readonly string[],
) => Promise<{
  stdout: string;
  stderr: string;
}>;

export class GhCliLabelAdapter implements GitHubLabelAdapter {
  private readonly repo: string;
  private readonly executor: CommandExecutor;

  public constructor(owner: string, repo: string, executor: CommandExecutor = defaultExecutor) {
    this.repo = `${owner}/${repo}`;
    this.executor = executor;
  }

  public async listLabels(): Promise<Array<{ name: string }>> {
    const result = await this.executor('gh', ['label', 'list', '--repo', this.repo, '--limit', '200', '--json', 'name']);
    const parsed = JSON.parse(result.stdout) as Array<{ name?: unknown }>;

    return parsed.flatMap((label) => (typeof label.name === 'string' ? [{ name: label.name }] : []));
  }

  public async createLabel(label: LabelDefinition): Promise<void> {
    await this.executor('gh', [
      'label',
      'create',
      label.name,
      '--repo',
      this.repo,
      '--color',
      label.color,
      '--description',
      label.description,
    ]);
  }
}

async function defaultExecutor(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, [...args]);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Failed to run ${file} ${args.join(' ')}: ${message}`);
  }
}
