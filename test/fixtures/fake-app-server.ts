import { createInterface } from 'node:readline';

const account = process.argv.includes('--no-account') ? null : { type: 'chatgpt' };
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const request = JSON.parse(line) as { id?: number | string; method?: string };
  if (request.id === undefined) return;
  const result = request.method === 'account/read' ? { account } : {};
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
