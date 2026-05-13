import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acceptsScreenshotArtifactPath,
  classifyChangedPaths,
  findDeniedPathMatch,
  globMatches,
  isRunnerVisualProofCodeArtifactPath,
  normalizePath,
} from '../src/path-policy.js';

test('path policy normalizes runner paths without losing top-level directories', () => {
  assert.equal(normalizePath('.\\x\\secret.txt'), 'x/secret.txt');
  assert.equal(normalizePath('./x/secret.txt'), 'x/secret.txt');
  assert.equal(normalizePath('src\\runner\\safety.ts'), 'src/runner/safety.ts');
});

test('path policy matches exact, segment wildcard, and recursive glob patterns', () => {
  assert.equal(globMatches('src/runner/safety.ts', './src/runner/safety.ts'), true);
  assert.equal(globMatches('src/*/safety.ts', 'src/runner/safety.ts'), true);
  assert.equal(globMatches('src/*/safety.ts', 'src/runner/nested/safety.ts'), false);
  assert.equal(globMatches('src/**/*.ts', 'src/runner/nested/safety.ts'), true);
  assert.equal(globMatches('src/**/*.ts', 'src/safety.ts'), true);
});

test('path policy finds denied path matches after normalization', () => {
  assert.deepEqual(findDeniedPathMatch('./secrets\\token.txt', ['.env*', 'secrets/**']), {
    path: 'secrets/token.txt',
    pattern: 'secrets/**',
  });
  assert.equal(findDeniedPathMatch('src/index.ts', ['.env*', 'secrets/**']), undefined);
});

test('path policy classifies runtime and test paths with configured globs', () => {
  assert.deepEqual(
    classifyChangedPaths(
      [
        'packages/runtime/session/index.ts',
        'packages/runtime/session/index.test.ts',
        'packages/runtime/top-level.test.ts',
        'docs/runtime.md',
      ],
      {
        runtimeChangedPathGlobs: ['packages/runtime/**/*.ts'],
        testChangedPathGlobs: ['packages/runtime/**/*.test.ts'],
      },
    ),
    {
      runtimeFiles: ['packages/runtime/session/index.ts'],
      testFiles: ['packages/runtime/session/index.test.ts', 'packages/runtime/top-level.test.ts'],
    },
  );
});

test('path policy accepts screenshot artifacts only when path evidence is credible', () => {
  assert.equal(acceptsScreenshotArtifactPath({
    artifactPath: '.proofs/issue-1/shot.png',
    artifactDir: '.proofs',
    changedFiles: ['src/frontend/CampaignList.tsx'],
    hasPassedRunnerVisualValidation: true,
    exists: () => true,
  }), true);
  assert.equal(acceptsScreenshotArtifactPath({
    artifactPath: '.proofs/issue-1/shot.png',
    artifactDir: '.proofs',
    changedFiles: ['src/frontend/CampaignList.tsx'],
    hasPassedRunnerVisualValidation: false,
    exists: () => true,
  }), false);
  assert.equal(acceptsScreenshotArtifactPath({
    artifactPath: '.proofs/issue-1/shot.png',
    artifactDir: '.proofs',
    changedFiles: ['.proofs/issue-1'],
    hasPassedRunnerVisualValidation: false,
    exists: () => true,
  }), true);
  assert.equal(acceptsScreenshotArtifactPath({
    artifactPath: '.proofs/issue-1/shot.png',
    artifactDir: '.proofs',
    changedFiles: ['.proof'],
    hasPassedRunnerVisualValidation: false,
    exists: () => true,
  }), false);
  assert.equal(acceptsScreenshotArtifactPath({
    artifactPath: 'tmp/shot.png',
    artifactDir: '.proofs',
    changedFiles: ['tmp'],
    hasPassedRunnerVisualValidation: true,
    exists: () => true,
  }), false);
  assert.equal(acceptsScreenshotArtifactPath({
    artifactPath: '.proofs/../outside/shot.png',
    artifactDir: '.proofs',
    changedFiles: ['.proofs'],
    hasPassedRunnerVisualValidation: true,
    exists: () => true,
  }), false);
  assert.equal(isRunnerVisualProofCodeArtifactPath('.proofs/issue-1/visual-proof.mjs', '.proofs'), true);
  assert.equal(isRunnerVisualProofCodeArtifactPath('.proofs/issue-1/shot.png', '.proofs'), false);
  assert.equal(isRunnerVisualProofCodeArtifactPath('tmp/visual-proof.mjs', '.proofs'), false);
});
