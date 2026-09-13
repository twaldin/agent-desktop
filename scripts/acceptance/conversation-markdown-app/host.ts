import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startHost } from '../../../apps/host/src/server';
import type { CommandEnvelope, CommandResult, SessionSummary, TranscriptMessage } from '../../../packages/shared/src/protocol';
import { COMMAND_KEYMAP_PREFERENCE, type PreferencesSnapshotV2 } from '../../../packages/shared/src/preferences-v2';

const root = resolve(process.argv[2]!);
if (process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, 'agent') || process.env.PI_DISABLE_DOTENV !== '1'
  || process.env.PATH?.split(delimiter)[0] !== join(root, 'bin') || await readFile(join(root, 'bin/tailscale'), 'utf8') !== '#!/bin/sh\nexit 1\n')
  throw new Error('An isolated Markdown fixture with explicit tailnet refusal is required.');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Outbound network is forbidden in Markdown acceptance.');
  return originalFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;
for (const name of ['data', 'agent', 'workspace']) await mkdir(join(root, name), { recursive: true });
await writeFile(join(root, 'agent/config.yml'), 'retry:\n  enabled: false\n');
const retainedPath = join(root, 'workspace/retained.txt');
await writeFile(retainedPath, 'Source file must remain unchanged.\n');
const options = { dataDirectory: join(root, 'data'), agentDirectory: join(root, 'agent'), discoveryDirectory: join(root, 'workspace'),
  workerPath: resolve(import.meta.dir, '../../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts'), tailscale: false, port: 0 };
let host = await startHost(options);
async function request(path: string, command?: CommandEnvelope['command']) {
  const response = await fetch(host.connection.origin + path, { headers: { Authorization: `Bearer ${host.connection.token}`, 'Content-Type': 'application/json' },
    ...(command ? { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), commandVersion: 11, command } satisfies CommandEnvelope) } : {}) });
  const value = await response.json(); if (!response.ok || command && !(value as CommandResult).ok) throw new Error('Native fixture operation failed: ' + JSON.stringify(value));
  return command ? (value as CommandResult & { ok: true }).value : value;
}
const command = (value: CommandEnvelope['command']) => request('/v11/commands', value);
try {
  const sessions: SessionSummary[] = [];
  for (let index = 0; index < 3; index++) sessions.push(await command({ type: 'session.create', projectId: null, cwd: join(root, 'workspace') }) as SessionSummary);
  await host.stop();
  // Real native journals are seeded only after their host/worker ownership ends.
  // These are recorded entries, not a provider run or an executed tool claim.
  const { SessionManager } = await import('@oh-my-pi/pi-coding-agent');
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const source = await SessionManager.open(sessions[0]!.sessionFile);
  source.appendMessage({ role: 'user', content: '**Markdown fixture user**\n\n```ts\n  keepWhitespace();  \n```', timestamp: 1_700_000_000_000 });
  source.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'EXCLUDED_REASONING_SENTINEL' }, { type: 'text', text: '## Literal assistant\n\n[relative](./retained.txt) and `inline`.' }, { type: 'toolCall', id: 'recorded-read', name: 'read', arguments: { path: 'retained.txt' } }],
    api: 'openai-responses', provider: 'EXCLUDED_PROVIDER_SENTINEL', model: 'EXCLUDED_MODEL_SENTINEL', usage, stopReason: 'toolUse', timestamp: 1_700_000_001_000 });
  source.appendMessage({ role: 'toolResult', toolCallId: 'recorded-read', toolName: 'read', content: [{ type: 'text', text: '```\n  recorded tool preview  \n````' }], isError: true,
    details: { truncation: { truncated: true, direction: 'middle', partialLine: true, totalLines: 20, outputLines: 3, artifactId: '1234' } }, timestamp: 1_700_000_002_000 });
  source.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Recorded final answer.' }], api: 'openai-responses', provider: 'EXCLUDED_PROVIDER_SENTINEL', model: 'EXCLUDED_MODEL_SENTINEL', usage,
    stopReason: 'error', errorMessage: 'Recorded visible response error.', timestamp: 1_700_000_003_000 });
  await source.flush(); await source.close();
  const alternate = await SessionManager.open(sessions[1]!.sessionFile);
  alternate.appendMessage({ role: 'user', content: 'Different native conversation.', timestamp: 1_700_000_004_000 });
  await alternate.flush(); await alternate.close();
  host = await startHost(options);
  const titles = ['Markdown source', 'Markdown alternate', 'Markdown empty'];
  for (const [index, session] of sessions.entries()) {
    await command({ type: 'session.rename', sessionId: session.id, title: titles[index]! });
    await command({ type: 'draft.put', expectedRevision: 0, draft: { id: `session:${session.id}`, projectId: null, text: `Retained ${titles[index]} draft`, model: null, thinkingLevel: 'high', approvalMode: 'always-ask' } });
  }
  const preferences = await request('/v2/preferences') as PreferencesSnapshotV2;
  const keymap = preferences.records.find(record => record.key === COMMAND_KEYMAP_PREFERENCE);
  await command({ type: 'preferences.keymap.mutate', mutation: { expectedRevision: keymap?.revision ?? null,
    edit: { type: 'command', commandId: 'copyConversationMarkdown', update: { type: 'set', accelerator: 'CmdOrCtrl+Shift+Y' } } } });
  const projected = await Promise.all(sessions.map(session => request(`/v1/sessions/${session.id}/messages`) as Promise<TranscriptMessage[]>));
  if (!projected[0]?.some(message => message.role === 'toolResult' && message.nativeId && message.tool?.output?.truncation?.truncated)
    || !projected[0]?.some(message => message.role === 'assistant' && message.nativeId && message.assistant?.errorMessage)
    || !projected[1]?.some(message => message.text.includes('Different native conversation.')) || projected[2]?.length !== 0)
    throw new Error('Real native projections do not expose the required seeded states.');
  const files = [...sessions.map(session => session.sessionFile), retainedPath];
  const hashes = Object.fromEntries(await Promise.all(files.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  await writeFile(join(root, 'ready.json'), JSON.stringify({ connection: host.connection, sessions: sessions.map((session, index) => ({ id: session.id, sessionFile: session.sessionFile, title: titles[index] })), projected, hashes }), { mode: 0o600 });
  let stopping = false;
  async function stop() { if (stopping) return; stopping = true; try { await host.stop(); process.exit(0); } catch (cause) { console.error(cause); process.exit(1); } }
  process.on('SIGTERM', () => void stop());
  for await (const chunk of process.stdin) if (String(chunk).trim() === 'stop') await stop();
} catch (cause) { await host.stop(); throw cause; }
