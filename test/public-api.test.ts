import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/index.js';
import { validConfig } from './fixtures/config.js';

test('exports config schema validator from the package entrypoint', () => {
  const result = validateConfig(validConfig);

  assert.equal(result.ok, true);
});
