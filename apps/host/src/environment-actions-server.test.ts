import { Database } from "bun:sqlite";
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeLocalEnvironment, type CommandEnvelope, type CommandResult, type LocalEnvironmentActionsState, type NativeTerminalInfo } from '@agent-desktop/shared';
import { startHost } from './server';
import { LocalEnvironmentStore } from './local-environments';
import { WorkspaceState } from '../../desktop/src/renderer/workspace-state';

const bundle = process.env.AGENT_TEST_TMUX_BUNDLE;
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 8000;
  while (!await check()) { if (Date.now() > end) throw new Error('Action output did not arrive'); await Bun.sleep(25); }
}

for (const namespace of ['.agent-desktop', '.codex', 'inherited']) test.skipIf(!bundle)(`${namespace}: configured actions use authenticated revisions, real terminals and durable renderer retry across host restart`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-action-http-')));
  const source = join(root, 'project'), foreign = join(root, 'foreign'), dataDirectory = join(root, 'data'), agentDirectory = join(root, 'agent');
  await Promise.all([source, foreign, agentDirectory].map(path => mkdir(path)));
  await mkdir(join(root, '.git'));
  await mkdir(join(foreign, '.git')); // This sibling repository must not inherit the fixture root config.
  const configRoot = namespace === 'inherited' ? root : source;
  const configStore = new LocalEnvironmentStore(configRoot);
  const saved = await configStore.save({ configPath: join(configRoot, namespace === 'inherited' ? '.codex' : namespace, 'environments', 'environment.toml'), expectedRevision: null, raw: serializeLocalEnvironment({ version: 1, name: 'Actions', setup: { script: 'touch SETUP_MUST_NOT_RUN' },
    actions: [{ name: 'Count run', icon: 'run', command: "printf 'executed\\n' >> action-runs; printf 'ACTION_READY\\n'" }] }) });
  if (saved.type !== 'saved') throw new Error('Fixture config not saved');
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  const nativeIds = new Set<string>();
  try {
    const start = () => startHost({ dataDirectory, agentDirectory, discoveryDirectory: source, workerPath: join(import.meta.dir, 'omp-workers/fixtures/no-provider-worker.ts'), nativeTerminalBundle: bundle!, port: 0, tailscale: false });
    host = await start();
    const request = (path: string, body?: unknown, authorized = true) => fetch(host!.connection.origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${host!.connection.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const send = async (envelope: CommandEnvelope, endpoint = '/v5/commands'): Promise<CommandResult> => {
      const response = await request(endpoint, envelope); expect(response.status).toBe(200); return response.json();
    };
    const add = async (path: string) => {
      const result = await send({ id: crypto.randomUUID(), command: { type: 'project.add', path } });
      if (!result.ok || !result.value || !('path' in result.value)) throw new Error('Project missing'); return result.value.id;
    };
    const projectId = await add(source), foreignId = await add(foreign), target = { projectId };
    const catalog = async (): Promise<LocalEnvironmentActionsState> => (await (await request('/v1/workspace/query', { target, query: { type: 'environment.actions' } })).json()).state;
    expect((await request('/v1/workspace/query', { target, query: { type: 'environment.actions' } }, false)).status).toBe(401);
    const initial = await catalog(); expect(initial).toMatchObject({ selectedConfigPath: saved.configPath, selectionRevision: 0, actions: [{ index: 0, name: 'Count run' }], available: true });
    const action = { type: 'environment.action' as const, configPath: saved.configPath, configRevision: saved.revision, selectionRevision: 0, actionIndex: 0 };
    const oldProtocol = await request('/v1/commands', { id: 'old-protocol', command: { type: 'workspace.mutate', target, action } });
    expect(oldProtocol.status).toBe(422); expect(await oldProtocol.json()).toMatchObject({ code: 'ENVIRONMENT_PROTOCOL_REQUIRED' });
    expect(await send({ id: 'foreign-config', command: { type: 'workspace.mutate', target: { projectId: foreignId }, action } })).toMatchObject({ ok: false });
    expect(await send({ id: 'stale-file', command: { type: 'workspace.mutate', target, action: { ...action, configRevision: '0'.repeat(64) } } })).toMatchObject({ ok: false });
    const cacheValues = new Map<string, string>();
    const cache = { read: async (key: string) => cacheValues.get(key) ?? null, write: async (key: string, value: string) => { cacheValues.set(key, value); } };
    const deliveries: CommandEnvelope[] = []; let dropReply = true;
    const bridge = {
      workspaceQuery: async (owner: typeof target | { sessionId: string }, query: unknown) => (await request('/v1/workspace/query', { target: owner, query })).json(),
      command: async (envelope: CommandEnvelope) => {
        deliveries.push(envelope); const result = await send(envelope);
        if (result.ok && result.value && 'type' in result.value && result.value.type === 'environment.action') nativeIds.add(result.value.terminal.id);
        if (dropReply) { dropReply = false; throw new Error('Injected lost reply after real terminal run'); } return result;
      }, subscribe: () => () => {},
    };
    const first = new WorkspaceState(bridge, host.store.host.id, target, cache); first.setConnected(true); await first.restore(); await first.loadEnvironmentActions();
    await first.mutate(action);
    await until(async () => await readFile(join(source, 'action-runs'), 'utf8').catch(() => '') === 'executed\n');
    const db = new Database(join(dataDirectory, 'state.sqlite'), { readonly: true });
    try { expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(5); } finally { db.close(); }
    expect(first.pending?.uncertain).toBe(true); expect(first.mutationReceipt).toBeUndefined();
    const original = deliveries[0]!;
    await host.stop(); host = undefined; host = await start();
    const second = new WorkspaceState(bridge, host.store.host.id, target, cache); second.setConnected(true); await second.restore(); await second.retry();
    expect(deliveries).toEqual([original, original]); expect(second.pending).toBeUndefined();
    const receipt = second.mutationReceipt;
    expect(receipt?.commandId).toBe(original.id);
    if (receipt?.value.type !== 'environment.action') throw new Error('Action receipt missing');
    const terminal: NativeTerminalInfo = receipt.value.terminal;
    expect(await readFile(join(source, 'action-runs'), 'utf8')).toBe('executed\n');
    await second.mutate(action); expect(second.errors.action).toBeUndefined(); await until(async () => await readFile(join(source, 'action-runs'), 'utf8') === 'executed\nexecuted\n');
    expect(second.mutationReceipt?.value).toMatchObject({ type: 'environment.action', terminal: { id: terminal.id } }); expect(nativeIds.size).toBe(1);
    expect(await send({ id: 'select-none', command: { type: 'workspace.mutate', target, action: { type: 'environment.select', configPath: null, expectedRevision: 0 } } })).toMatchObject({ ok: true, value: { state: { selectionRevision: 1, selectedConfigPath: null, actions: [] } } });
    expect(await send({ id: 'stale-selection', command: { type: 'workspace.mutate', target, action } })).toMatchObject({ ok: false });
    await host.stop(); host = undefined; host = await start();
    expect(await catalog()).toMatchObject({ selectionRevision: 1, selectedConfigPath: null, actions: [] });
    expect(host.store.listSessions()).toHaveLength(0);
    expect(await readFile(join(source, 'SETUP_MUST_NOT_RUN'), 'utf8').catch(() => null)).toBeNull();
    expect(JSON.stringify(await (await request('/v1/state')).json())).not.toContain('action-runs');
  } finally {
    if (host) for (const id of nativeIds) await fetch(host.connection.origin + '/v2/terminals/action', { method: 'POST', headers: { Authorization: `Bearer ${host.connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'close', terminalId: id }) }).catch(() => {});
    await host?.stop(); await rm(root, { recursive: true, force: true });
  }
}, 40_000);
