import { isAbsolute, posix } from 'node:path';
import type { TestBaselineEvidence } from './runner-checks.js';

export type JestBaselineEvidence = TestBaselineEvidence & { kind: 'jest' };

const diagnostics = {
  'candidate-execution': ['The configured Jest command did not complete normally.', 'Inspect the original check log for process, resource, or output errors before retrying.'],
  'candidate-report': ['Jest did not produce a complete assertion failure report.', 'Inspect the original check log for a failed suite, setup error, or unsupported Jest invocation.'],
  'unsupported-scope': ['The change includes paths whose Jest impact cannot be established.', 'Configure an affected-test command that covers these changes.'],
  'uncovered-source': ['Jest found no related tests for a changed file.', 'Add coverage or configure a Jest project that includes the changed file.'],
  'affected-suite': ['A related Jest suite failed, was skipped, or did not run.', 'Run and fix the affected tests before retrying.'],
  'base-preparation': ['The Runner could not materialize the exact base tree.', 'Inspect the archive logs and run the full check if the base uses unsupported Git attributes, links, or submodules.'],
  'base-lockfile': ['The base commit has no npm lockfile.', 'Provide a committed npm lockfile or run the full check successfully.'],
  'base-command': ['The configured Jest invocation could not be reproduced on the base commit.', 'Use a comparable locked Jest invocation or run the full candidate check successfully.'],
  'base-install': ['Installing the locked dependencies on the base commit failed.', 'Inspect the retained npm install log and make missing locked dependencies available in the local cache.'],
  'snapshot-failure': ['Jest reported a snapshot failure in addition to any assertion failures.', 'Inspect the snapshot diff and resolve it before retrying.'],
  'dependency-trace': ['The Runner could not verify the modules loaded by the failing Jest suites.', 'Inspect the retained Jest trace check logs and run the full check successfully.'],
  'external-dependency': ['A failing Jest suite uses local filesystem or subprocess APIs outside the module graph.', 'Run the full check successfully or isolate the failing suite from those dependencies.'],
  'affected-load': ['A failing Jest suite loaded a changed file at runtime.', 'Fix the affected suite before retrying.'],
  'comparison-timeout': ['The Jest baseline comparison exceeded the host check time budget.', 'Inspect the retained logs and increase the configured timeout if the checks need more time.'],
  'configuration-output': ['The Runner could not read Jest’s resolved configuration.', 'Inspect the configured Jest command and run the full check successfully.'],
  'configuration-selection': ['Jest uses a selection or early-exit setting that prevents a complete comparison.', 'Run a complete Jest check without filtering or early exit.'],
  'configuration-coverage': ['The configured Jest check collects coverage, which can fail independently of assertions.', 'Run the full coverage check successfully before retrying.'],
  'configuration-reporting': ['A custom Jest reporter or results processor can change the check outcome.', 'Run the configured check successfully with its custom reporting enabled.'],
  'configuration-hooks': ['A local Jest hook can load files outside the dependency graph.', 'Run the full check successfully or isolate the hook dependencies.'],
  'replay-mismatch': ['The machine-readable Jest replay did not reproduce the original failure output.', 'Compare the two runs in the retained check log and fix the original failure or any nondeterminism before retrying.'],
  'related-selection': ['Jest could not reliably enumerate the affected suites.', 'Inspect the retained test selection logs and correct the Jest project configuration.'],
  'base-passed': ['The full Jest check passed on the base commit but failed on the candidate.', 'Inspect the candidate failure and fix the regression before retrying.'],
  'base-report': ['Jest on the base commit did not produce a comparable assertion failure report.', 'Inspect the base check log and resolve the differing test or environment failure.'],
  'failure-mismatch': ['The failing Jest assertions or their error messages differ from the base commit.', 'Investigate the candidate failure and fix the regression before retrying.'],
} as const;

export interface JestDiagnostic {
  code: keyof typeof diagnostics;
  file?: string;
}

export function jestDiagnosticText(diagnostic: JestDiagnostic): readonly [string, string] {
  return diagnostics[diagnostic.code];
}

export function jestEvidencePath(file: unknown): file is string {
  return typeof file === 'string' && file.length > 0 && file.length <= 500
    && !isAbsolute(file) && !file.startsWith('-') && !file.includes('\\') && !file.includes(' :: ')
    && posix.normalize(file) === file && !file.split('/').some(part => part === '.' || part === '..')
    && !/[\u0000-\u001f\u007f]/u.test(file);
}

export function validJestDiagnostic(value: unknown): value is JestDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return typeof d.code === 'string' && Object.hasOwn(diagnostics, d.code)
    && Object.keys(d).every(key => key === 'code' || key === 'file')
    && (!Object.hasOwn(d, 'file') || jestEvidencePath(d.file));
}
