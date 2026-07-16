import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AppServerClient } from '../src/codex/app-server-client.js';

test('app-server client correlates responses and notifications', async () => {
  const toServer = new PassThrough(); const fromServer = new PassThrough();
  const client = new AppServerClient(toServer, fromServer);
  let request = '';
  toServer.once('data', (chunk) => { request = String(chunk); fromServer.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`); });
  const notification = client.waitForNotification<any>('turn/completed', (params) => params.turn.id === 'turn-1');
  assert.deepEqual(await client.request('initialize', {}), { ok: true });
  assert.match(request, /"method":"initialize"/);
  fromServer.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } })}\n`);
  assert.equal((await notification).turn.id, 'turn-1');
});

test('app-server client responds fail-closed to every pinned server request class', async () => {
  const toServer = new PassThrough(); const fromServer = new PassThrough();
  new AppServerClient(toServer, fromServer);
  const responses: any[] = [];
  toServer.on('data', (chunk) => responses.push(...String(chunk).trim().split('\n').map((line) => JSON.parse(line))));
  const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/permissions/requestApproval', 'item/tool/call', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'currentTime/read', 'applyPatchApproval', 'execCommandApproval', 'unknown/request'];
  methods.forEach((method, index) => fromServer.write(`${JSON.stringify({ id: index + 1, method, params: {} })}\n`));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses.length, methods.length);
  assert.deepEqual(responses[0].result, { decision: 'decline' });
  assert.equal(responses[6].error.code, -32001);
  assert.equal(responses.at(-1).error.code, -32601);
});
