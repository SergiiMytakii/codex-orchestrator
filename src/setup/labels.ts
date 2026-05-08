import type { LabelDefinition, LabelPreparationPolicy } from '../config/schema.js';

export interface GitHubLabelAdapter {
  listLabels(): Promise<Array<{ name: string }>>;
  createLabel(label: LabelDefinition): Promise<void>;
}

export interface LabelPlan {
  policy: LabelPreparationPolicy;
  existing: string[];
  missing: LabelDefinition[];
  created: LabelDefinition[];
  wouldCreate: LabelDefinition[];
}

export async function planLabels(
  adapter: GitHubLabelAdapter,
  labels: Record<string, LabelDefinition>,
  policy: LabelPreparationPolicy,
  dryRun: boolean,
): Promise<LabelPlan> {
  const existingLabels = await adapter.listLabels();
  const existing = existingLabels.map((label) => label.name);
  const existingNames = new Set(existing);
  const missing = Object.values(labels).filter((label) => !existingNames.has(label.name));
  const created: LabelDefinition[] = [];
  const wouldCreate = policy === 'create-missing' ? missing : [];

  if (policy === 'create-missing' && !dryRun) {
    for (const label of missing) {
      await adapter.createLabel(label);
      created.push(label);
    }
  }

  return {
    policy,
    existing,
    missing,
    created,
    wouldCreate,
  };
}

export class InMemoryGitHubLabelAdapter implements GitHubLabelAdapter {
  private readonly labels = new Map<string, LabelDefinition>();

  public createdLabels: LabelDefinition[] = [];

  public constructor(labels: Array<{ name: string }> = []) {
    for (const label of labels) {
      this.labels.set(label.name, {
        name: label.name,
        color: '000000',
        description: '',
      });
    }
  }

  public async listLabels(): Promise<Array<{ name: string }>> {
    return Array.from(this.labels.values()).map((label) => ({ name: label.name }));
  }

  public async createLabel(label: LabelDefinition): Promise<void> {
    this.labels.set(label.name, label);
    this.createdLabels.push(label);
  }
}
