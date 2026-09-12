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
for (const path of ['data', 'agent', 'project']) await mkdir(join(fixture, path), { recursive: true });
await writeFile(join(fixture, 'project', 'README.md'), '# Open panel fixture\n');
await writeFile(join(fixture, 'agent', 'config.yml'), 'tools:\n  approvalMode: always-ask\n');
const { startHost } = await import('../../../apps/host/src/server');
const host = await startHost({ dataDirectory: join(fixture, 'data'), agentDirectory: join(fixture, 'agent'), discoveryDirectory: join(fixture, 'project'), workerPath: resolve(import.meta.dir, '../../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts'), tailscale: false, port: 0 });
await writeFile(join(fixture, 'connection.json'), JSON.stringify(host.connection), { mode: 0o600 });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; try { await host.stop(); process.exit(0); } catch (error) { console.error(error); process.exit(1); } }
process.on('SIGTERM', () => void stop());
for await (const chunk of process.stdin) if (String(chunk).trim() === 'stop') await stop();
