import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const fixture = resolve(process.argv[2]!);
if (process.env.HOME !== fixture || process.env.PI_CODING_AGENT_DIR !== join(fixture, 'agent')) throw new Error('An isolated host environment is required.');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Outbound provider/network fetch forbidden in Open panel fixture.');
  return originalFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;
for (const path of ['data', 'agent', 'project', 'gates']) await mkdir(join(fixture, path), { recursive: true });
await writeFile(join(fixture, 'project', 'README.md'), '# Open panel fixture\n');
await writeFile(join(fixture, 'agent', 'config.yml'), 'tools:\n  approvalMode: always-ask\n');
if (process.env.MCP_OWNER_FIXTURE === '1') await writeFile(join(fixture, 'agent', 'config.yml'), `tools:\n  approvalMode: always-ask\nextensions:\n  - ${JSON.stringify(resolve(import.meta.dir, '../../../apps/host/src/omp/fixtures/mcp-owner-startup.ts'))}\n`);
if (process.env.ARTIFACT_APP_FIXTURE === '1' || process.env.MCP_OWNER_VIEWER_FIXTURE === '1') {
  await writeFile(join(fixture, 'project', 'sample.report.note'), 'Original file note');
  if (process.env.MCP_OWNER_VIEWER_FIXTURE !== '1') await writeFile(join(fixture, 'agent', 'config.yml'), `tools:\n  approvalMode: always-ask\nextensions:\n  - ${JSON.stringify(resolve(import.meta.dir, '../../../apps/host/src/omp-workers/fixtures/artifact-provider.ts'))}\nretry:\n  enabled: false\n`);
  await writeFile(join(fixture, 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath,
    args: [resolve(import.meta.dir, '../../../apps/host/src/omp/fixtures/artifact-server.ts')], env: { ARTIFACT_TEST_HTML: join(fixture, 'mcp-ui.html'), ARTIFACT_TEST_LOG: join(fixture, 'mcp-requests.jsonl') } } } }));
}
else if (process.env.MCP_APP_FIXTURE === '1') await writeFile(join(fixture, 'agent', 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath,
  args: [resolve(import.meta.dir, '../../../apps/host/src/omp/fixtures/mcp-app-server.ts')], env: { MCP_APP_TEST_HTML: join(fixture, 'mcp-ui.html'), MCP_APP_TEST_LOG: join(fixture, 'mcp-requests.jsonl') } } } }));
if (process.env.SUGGESTED_OUTPUTS_FIXTURE === '1') {
  await writeFile(join(fixture, 'project', 'input.md'), '# Input only'); await writeFile(join(fixture, 'project', 'blocked'), 'Not a directory');
  await writeFile(join(fixture, 'agent', 'config.yml'), `generate_image:\n  enabled: true\nbrowser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nextensions:\n  - ${JSON.stringify(resolve(import.meta.dir, '../../../apps/host/src/omp-workers/fixtures/suggested-provider.ts'))}\nretry:\n  enabled: false\n`);
}
const website = process.env.SUGGESTED_OUTPUTS_FIXTURE === '1' ? Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>Original saved website</title><h1>Original saved website</h1>', { headers: { 'Content-Type': 'text/html' } }) }) : undefined;
if (website) { process.env.SUGGESTED_WEBSITE_URL = website.url.href; await writeFile(join(fixture, 'website.json'), JSON.stringify({ url: website.url.href })); }
const { startHost } = await import('../../../apps/host/src/server');
const host = await startHost({ dataDirectory: join(fixture, 'data'), agentDirectory: join(fixture, 'agent'), discoveryDirectory: join(fixture, 'project'), workerPath: resolve(import.meta.dir, process.env.SUGGESTED_OUTPUTS_FIXTURE === '1' ? '../../../apps/host/src/omp-workers/fixtures/suggested-worker.ts' : '../../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts'), nativeTerminalBundle: process.argv[3], tailscale: false, port: 0 });
await writeFile(join(fixture, 'connection.json'), JSON.stringify(host.connection), { mode: 0o600 });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; try { await host.stop(); website?.stop(true); process.exit(0); } catch (error) { console.error(error); process.exit(1); } }
process.on('SIGTERM', () => void stop());
for await (const chunk of process.stdin) if (String(chunk).trim() === 'stop') await stop();
