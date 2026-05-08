import type { LabelDefinition } from '../config/schema.js';
import type { CommandExecutor } from '../github/gh-cli.js';
import { defaultGhExecutor } from '../github/gh-cli.js';
import type { GitHubLabelAdapter } from './labels.js';

export class GhCliLabelAdapter implements GitHubLabelAdapter {
  private readonly repo: string;
  private readonly executor: CommandExecutor;

  public constructor(owner: string, repo: string, executor: CommandExecutor = defaultGhExecutor) {
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
