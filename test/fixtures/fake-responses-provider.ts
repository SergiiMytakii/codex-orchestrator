import { createServer, type Server } from 'node:http';

export interface FakeResponsesProvider {
  baseUrl: string;
  requests: unknown[];
  close(): Promise<void>;
}

export async function startFakeResponsesProvider(): Promise<FakeResponsesProvider> {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses' || request.headers.authorization !== 'Bearer fake-key') {
      response.writeHead(404).end(); return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const completed = { id: 'resp_fake', object: 'response', created_at: 1, status: 'completed', error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model: 'fake-model', output: [{ id: 'msg_fake', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], logprobs: [], text: '{"version":1,"nodeId":"scoped-classification","outcome":"blocked","artifactRefs":["artifact://fake"],"result":{}}' }] }], parallel_tool_calls: false, previous_response_id: null, reasoning: { effort: 'low', summary: null }, store: false, temperature: null, text: { format: { type: 'text' }, verbosity: 'medium' }, tool_choice: 'auto', tools: [], top_p: null, truncation: 'disabled', usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }, user: null, metadata: {} };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake provider failed to bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, close: () => close(server) };
}

function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
