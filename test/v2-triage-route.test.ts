import assert from 'node:assert/strict';
import test from 'node:test';

import { triageRouteOutputSchema, validateTriageRoute } from '../src/v2/triage-route.js';

const evidence = [{ kind: 'issue', location: '#1', summary: 'Read the issue.' }];

const direct = {
  version: 1,
  status: 'direct',
  inspectedEvidence: evidence,
  assumptions: [],
  direct: { summary: 'Small change.', behaviors: ['Change behavior.'], verification: ['Run test.'] },
  specRequired: null,
  awaitingUser: null,
  blocker: null,
};

test('triage route validator accepts every exact discriminated branch', () => {
  assert.equal(validateTriageRoute(direct).status, 'direct');
  assert.equal(validateTriageRoute({
    ...direct,
    status: 'spec-required',
    direct: null,
    specRequired: {
      summary: 'Stateful change.',
      complexityReasons: ['Persistence contract.'],
      specMode: 'standard',
      reviewFocus: ['Recovery.'],
    },
  }).status, 'spec-required');
  assert.equal(validateTriageRoute({
    ...direct,
    status: 'awaiting-user',
    direct: null,
    awaitingUser: {
      outcomes: [
        { id: 'a', title: 'A', behaviorDelta: 'Behavior A.', evidence: ['No source choice.'] },
        { id: 'b', title: 'B', behaviorDelta: 'Behavior B.', evidence: ['No source choice.'] },
      ],
      absenceOfAuthorizedChoiceEvidence: ['Issue and code do not choose.'],
      recommendation: 'Choose A.',
      question: 'Should the product use A or B?',
    },
  }).status, 'awaiting-user');
  assert.equal(validateTriageRoute({
    ...direct,
    status: 'blocked',
    direct: null,
    blocker: { kind: 'external', code: 'missing-service', summary: 'Service unavailable.', evidence: ['Probe failed.'] },
  }).status, 'blocked');
});

test('triage route validator rejects wrong discriminants, cardinality, duplicates, and unknown keys', () => {
  assert.throws(() => validateTriageRoute({ ...direct, version: 2 }), /version/u);
  assert.throws(() => validateTriageRoute({ ...direct, status: 'other' }), /status/u);
  assert.throws(() => validateTriageRoute({ ...direct, specRequired: {} }), /inactive|null/u);
  assert.throws(() => validateTriageRoute({ ...direct, inspectedEvidence: [] }), /inspectedEvidence/u);
  assert.throws(() => validateTriageRoute({ ...direct, assumptions: ['same', 'same'] }), /unique/u);
  assert.throws(() => validateTriageRoute({ ...direct, extra: true }), /unknown|keys/u);

  const waiting = {
    ...direct,
    status: 'awaiting-user',
    direct: null,
    awaitingUser: {
      outcomes: [
        { id: 'same', title: 'A', behaviorDelta: 'A.', evidence: ['A.'] },
        { id: 'same', title: 'B', behaviorDelta: 'B.', evidence: ['B.'] },
      ],
      absenceOfAuthorizedChoiceEvidence: ['None.'],
      recommendation: 'A.',
      question: 'A or B?',
    },
  };
  assert.throws(() => validateTriageRoute(waiting), /outcome IDs|unique/u);
});

test('triage route output schema is Structured Outputs compatible and keeps semantic uniqueness in runtime', () => {
  const schema = triageRouteOutputSchema();
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['report']);
  assert.equal(JSON.stringify(schema).includes('uniqueItems'), false);
  assert.equal(JSON.stringify(schema).includes('oneOf'), false);
});
