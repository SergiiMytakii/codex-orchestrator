export interface CodexOrchestratorConfig {
  github: {
    owner: string;
    repo: string;
    issueLabels: {
      auto: string;
      planAuto: string;
    };
  };
  runner: {
    workspaceRoot: string;
    maxParallelChildren: number;
  };
  codex: {
    adapter: 'codex-cli';
  };
  project: {
    configDir: '.codex-orchestrator';
  };
}

export type ConfigValidationResult =
  | { ok: true; value: CodexOrchestratorConfig }
  | { ok: false; errors: string[] };

type ObjectRecord = Record<string, unknown>;

export function validateConfig(input: unknown): ConfigValidationResult {
  const errors: string[] = [];
  const root = asObject(input);

  if (!root) {
    return { ok: false, errors: ['config must be an object'] };
  }

  const github = expectObject(root, 'github', errors);
  const runner = expectObject(root, 'runner', errors);
  const codex = expectObject(root, 'codex', errors);
  const project = expectObject(root, 'project', errors);
  const issueLabels = github ? expectObject(github, 'github.issueLabels', errors) : undefined;

  const owner = github ? expectString(github, 'github.owner', errors) : undefined;
  const repo = github ? expectString(github, 'github.repo', errors) : undefined;
  const auto = issueLabels ? expectString(issueLabels, 'github.issueLabels.auto', errors) : undefined;
  const planAuto = issueLabels ? expectString(issueLabels, 'github.issueLabels.planAuto', errors) : undefined;
  const workspaceRoot = runner ? expectString(runner, 'runner.workspaceRoot', errors) : undefined;
  const maxParallelChildren = runner ? expectParallelLimit(runner, errors) : undefined;
  const adapter = codex ? expectLiteral(codex, 'codex.adapter', 'codex-cli', errors) : undefined;
  const configDir = project ? expectLiteral(project, 'project.configDir', '.codex-orchestrator', errors) : undefined;

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      github: {
        owner: owner as string,
        repo: repo as string,
        issueLabels: {
          auto: auto as string,
          planAuto: planAuto as string,
        },
      },
      runner: {
        workspaceRoot: workspaceRoot as string,
        maxParallelChildren: maxParallelChildren as number,
      },
      codex: {
        adapter: adapter as 'codex-cli',
      },
      project: {
        configDir: configDir as '.codex-orchestrator',
      },
    },
  };
}

function asObject(value: unknown): ObjectRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as ObjectRecord;
}

function expectObject(parent: ObjectRecord, path: string, errors: string[]): ObjectRecord | undefined {
  const value = readPath(parent, path);
  const objectValue = asObject(value);

  if (!objectValue) {
    errors.push(`${path} must be an object`);
    return undefined;
  }

  return objectValue;
}

function expectString(parent: ObjectRecord, path: string, errors: string[]): string | undefined {
  const value = readPath(parent, path);

  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return undefined;
  }

  return value;
}

function expectLiteral<TLiteral extends string>(
  parent: ObjectRecord,
  path: string,
  expected: TLiteral,
  errors: string[],
): TLiteral | undefined {
  const value = readPath(parent, path);

  if (value !== expected) {
    errors.push(`${path} must be ${expected}`);
    return undefined;
  }

  return expected;
}

function expectParallelLimit(parent: ObjectRecord, errors: string[]): number | undefined {
  const value = readPath(parent, 'runner.maxParallelChildren');

  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > 3) {
    errors.push('runner.maxParallelChildren must be an integer between 1 and 3');
    return undefined;
  }

  return value;
}

function readPath(parent: ObjectRecord, path: string): unknown {
  const keys = path.split('.');
  const lastKey = keys[keys.length - 1];

  if (lastKey === undefined) {
    return undefined;
  }

  return parent[lastKey];
}
