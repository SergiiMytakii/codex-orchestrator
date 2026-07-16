import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AppServerClient } from '../src/codex/app-server-client.js';
import { canonical, loadToolCatalogFixture, projectToolCatalogEntry } from '../src/codex/tool-catalog.js';
import { startFakeResponsesProvider } from './fixtures/fake-responses-provider.js';

test('pinned Codex app-server exposes only the approved first-request tool catalog', { timeout: 30_000 }, async () => {
  const fixture = await loadToolCatalogFixture(resolve('runtime-skills/tool-catalogs/codex-0.144.4.json'));
  const provider = await startFakeResponsesProvider();
  const home = await mkdtemp(join(tmpdir(), 'codex-app-server-home-'));
  const child = spawn('codex', ['app-server',
    '-c', 'model="fake-model"', '-c', 'model_provider="orchestrator_fake"',
    '-c', 'model_providers.orchestrator_fake.name="Orchestrator Fake Responses"',
    '-c', `model_providers.orchestrator_fake.base_url="${provider.baseUrl}/v1"`,
    '-c', 'model_providers.orchestrator_fake.env_key="FAKE_RESPONSES_KEY"',
    '-c', 'model_providers.orchestrator_fake.wire_api="responses"',
    '-c', 'features.apps=false', '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false',
    '-c', 'skills.include_instructions=false', '-c', 'web_search="disabled"',
  ], { env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, FAKE_RESPONSES_KEY: 'fake-key' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new AppServerClient(child.stdin, child.stdout);
  try {
    await client.request('initialize', { clientInfo: { name: 'contract-test', title: 'Contract Test', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    client.notify('initialized');
    await client.request('skills/extraRoots/set', { extraRoots: [resolve('runtime-skills')] });
    const started: any = await client.request('thread/start', { model: 'fake-model', modelProvider: 'orchestrator_fake', cwd: resolve('.'), approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, dynamicTools: [], environments: [] });
    const threadId = started.thread.id;
    const completed = client.waitForNotification<any>('turn/completed', (params) => params?.threadId === threadId);
    await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'Return a blocked envelope.', text_elements: [] }, { type: 'skill', name: 'scoped-classification', path: resolve('runtime-skills/operations/scoped-classification/SKILL.md') }], approvalPolicy: 'never', cwd: resolve('.'), effort: 'low' });
    await completed;
    assert.equal(provider.requests.length, 1);
    const tools = (provider.requests[0] as any).tools
      .map(projectToolCatalogEntry)
      .sort((left: any, right: any) => Buffer.compare(Buffer.from(`${left.type}\0${left.name}`), Buffer.from(`${right.type}\0${right.name}`)));
    assert.deepEqual(tools.map((tool: any) => `${tool.type}:${tool.name}`), [
      'function:exec_command', 'function:request_user_input', 'function:update_plan', 'function:view_image', 'function:write_stdin', 'namespace:skills',
    ]);
    assert.equal(canonical(tools), canonical(fixture.variants['read-only']));
  } finally {
    client.close(); child.kill('SIGTERM'); await provider.close();
  }
});
