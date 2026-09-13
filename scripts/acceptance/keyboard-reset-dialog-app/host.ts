import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { startHost } from '../../../apps/host/src/server';
import type { CommandEnvelope, CommandResult } from '../../../packages/shared/src/protocol';
import { COMMAND_KEYMAP_PREFERENCE, type PreferencesSnapshotV2 } from '../../../packages/shared/src/preferences-v2';

const root = resolve(process.argv[2]!);
if (process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, 'agent') || process.env.PI_DISABLE_DOTENV !== '1'
  || process.env.PATH?.split(delimiter)[0] !== join(root, 'bin') || await readFile(join(root, 'bin/tailscale'), 'utf8') !== '#!/bin/sh\nexit 1\n')
  throw new Error('An isolated reset fixture with explicit tailnet refusal is required.');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Outbound network is forbidden in reset-dialog acceptance.');
  return originalFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;
for (const name of ['data', 'agent', 'workspace']) await mkdir(join(root, name), { recursive: true });
await writeFile(join(root, 'agent/config.yml'), 'retry:\n  enabled: false\n');
const host = await startHost({ dataDirectory: join(root, 'data'), agentDirectory: join(root, 'agent'), discoveryDirectory: join(root, 'workspace'),
  workerPath: resolve(import.meta.dir, '../../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts'), tailscale: false, port: 0 });
try {
  const headers = { Authorization: `Bearer ${host.connection.token}`, 'Content-Type': 'application/json' };
  const response = await fetch(host.connection.origin + '/v2/preferences', { headers });
  if (!response.ok) throw new Error('Could not read the actual fixture keymap.');
  const before = await response.json() as PreferencesSnapshotV2;
  const previous = before.records.find(record => record.key === COMMAND_KEYMAP_PREFERENCE);
  const envelope: CommandEnvelope = { id: crypto.randomUUID(), commandVersion: 11, command: { type: 'preferences.keymap.mutate', mutation: {
    expectedRevision: previous?.revision ?? null, edit: { type: 'command', commandId: 'newTask', update: { type: 'clear' } },
  } } };
  const seeded = await fetch(host.connection.origin + '/v11/commands', { method: 'POST', headers, body: JSON.stringify(envelope) });
  const receipt = await seeded.json() as CommandResult;
  if (!seeded.ok || !receipt.ok || !receipt.value || !('type' in receipt.value) || receipt.value.type !== 'preferences.keymap.mutate') throw new Error('Real command11 seed was not confirmed: ' + JSON.stringify(receipt));
  const record = receipt.value.preference;
  if (record.deleted || !record.value.overrides.some(binding => binding.command === 'newTask' && binding.keys.length === 0)) throw new Error('The disposable custom shortcut was not retained.');
  await writeFile(join(root, 'ready.json'), JSON.stringify({ connection: host.connection, seed: { envelope, record } }), { mode: 0o600 });
  let stopping = false;
  async function stop() { if (stopping) return; stopping = true; try { await host.stop(); process.exit(0); } catch (cause) { console.error(cause); process.exit(1); } }
  process.on('SIGTERM', () => void stop());
  for await (const chunk of process.stdin) if (String(chunk).trim() === 'stop') await stop();
} catch (cause) { await host.stop(); throw cause; }
