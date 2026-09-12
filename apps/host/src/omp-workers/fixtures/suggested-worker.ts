// Actual production Worker/SDK/tools. Only the image provider HTTP response is
// deterministic; no network request or personal credential can leave this child.
import { appendFileSync } from 'node:fs';
const log = process.env.SUGGESTED_PROVIDER_LOG;
if (!log || process.env.DEEPINFRA_API_KEY !== 'isolated-suggested-fixture') throw new Error('A disposable Suggested provider boundary is required.');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).hostname === '127.0.0.1') return originalFetch(input, init);
  if (url !== 'https://api.deepinfra.com/v1/openai/images/generations' || init?.method !== 'POST') throw new Error('Outbound fetch is forbidden in Suggested fixture.');
  const body = JSON.parse(String(init.body));
  if (body.n !== 1 || body.response_format !== 'b64_json') throw new Error('Unexpected native image request.');
  appendFileSync(log, JSON.stringify({ url, body }) + '\n');
  return Response.json({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' }] });
}, { preconnect: () => {} }) as typeof fetch;
await import('../entry');
