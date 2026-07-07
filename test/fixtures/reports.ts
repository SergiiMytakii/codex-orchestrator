import type { ProofPlan } from '../../src/runner/completion-report.js';

export const defaultProofPlan: ProofPlan = {
  mode: 'non-visual-smoke',
  reason: 'Focused validation proves the non-visual acceptance criteria.',
  validationCommands: ['npm test'],
  requiredArtifacts: [],
};
