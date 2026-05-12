export interface LocalExecutionPhaseInput {
  phaseId: string;
  worktreePath: string;
}

export interface LocalExecutionPhaseResult {
  phaseId: string;
  status: 'passed' | 'failed';
  validation: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; summary: string }>;
  artifacts: Array<{ type: 'log' | 'screenshot' | 'other'; path?: string; url?: string; description: string }>;
  residualRisks: string[];
}

export type LocalExecutionPhaseExecutor = (input: LocalExecutionPhaseInput) => Promise<LocalExecutionPhaseResult>;

export interface LocalExecutionSessionInput {
  worktreePath: string;
  phases: string[];
  executePhase: LocalExecutionPhaseExecutor;
}

export interface LocalExecutionSessionResult {
  worktreePath: string;
  phaseResults: LocalExecutionPhaseResult[];
  status: 'passed' | 'blocked';
  publishReady: boolean;
}

export async function runLocalExecutionSession(input: LocalExecutionSessionInput): Promise<LocalExecutionSessionResult> {
  const phaseResults: LocalExecutionPhaseResult[] = [];

  for (const phaseId of input.phases) {
    const result = await input.executePhase({ phaseId, worktreePath: input.worktreePath });
    if (result.phaseId !== phaseId) {
      throw new Error(`Local execution phase ${phaseId} returned mismatched result for ${result.phaseId}`);
    }
    phaseResults.push(result);
    if (result.status === 'failed') {
      return {
        worktreePath: input.worktreePath,
        phaseResults,
        status: 'blocked',
        publishReady: false,
      };
    }
  }

  return {
    worktreePath: input.worktreePath,
    phaseResults,
    status: 'passed',
    publishReady: true,
  };
}
