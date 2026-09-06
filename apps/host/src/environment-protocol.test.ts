import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvironmentSelection, sameEnvironmentSelection, type CommandEnvelope, type CommandResult, type DraftInput, type HostState } from '@agent-desktop/shared';
import { HostStore } from './store';
import { startHost } from './server';
import { parseCommandEnvelope } from './validation';

const selection = { projectId: 'p', configPath: '/project/.agent-desktop/environments/dev.toml', revision: 'a'.repeat(64) };

test('environment selections keep explicit absence, project identity and exact revision through transport parsing', () => {
  expect(sameEnvironmentSelection(null, undefined)).toBe(false);
  expect(sameEnvironmentSelection(selection, { ...selection })).toBe(true);
  expect(sameEnvironmentSelection(selection, { ...selection, revision: 'b'.repeat(64) })).toBe(false);
  expect(parseEnvironmentSelection(null, null)).toBeNull();
  const draft = { id: 'd', projectId: 'p', text: 'preserve', model: null, environment: selection };
  const save = parseCommandEnvelope({ id: 'save', commandVersion: 5, command: { type: 'draft.put', draft, expectedRevision: 0 } });
  expect(save).toMatchObject({ commandVersion: 5, command: { draft } });
  const create = { type: 'session.create', projectId: 'p', worktree: { type: 'working-tree' }, environment: selection, draft: { id: 'd', revision: 1 } };
  expect(parseCommandEnvelope({ id: 'create', commandVersion: 5, command: create })).toMatchObject({ command: create });
  for (const value of [undefined, {}, { ...selection, projectId: 'other' }, { ...selection, revision: 'stale' }, { ...selection, configPath: 'relative' }])
    expect(() => parseCommandEnvelope({ id: 'bad', command: { type: 'draft.put', draft: { ...draft, environment: value }, expectedRevision: 0 } })).toThrow();
  for (const command of [{ ...create, worktree: undefined }, { ...create, draft: undefined }, { ...create, cwd: '/elsewhere' }, { type: 'session.interrupt', sessionId: 's', environment: null }])
    expect(() => parseCommandEnvelope({ id: 'bad', command })).toThrow();
});

test('saved environment format survives conflicts, newer edits, consumption and restart without a schema downgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-environment-draft-'));
  let store = new HostStore(root);
  try {
    const draft: DraftInput = { id: 'd', projectId: 'p', text: 'first prompt', model: null, environment: selection };
    expect(store.putDraft(draft, 0).ok).toBe(true);
    expect(store.putDraft({ ...draft, environment: null }, 0).ok).toBe(false);
    expect(store.listDraftConflicts('d')[0]?.attempted.environment).toBeNull();
    const newer = { ...draft, text: 'newer prompt', environment: { ...selection, revision: 'b'.repeat(64) } };
    expect(store.putDraft(newer, 1).ok).toBe(true);
    expect(store.consumeDraft({ id: 'd', revision: 1 }, 'older-prompt')).toBeUndefined();
    expect(store.getDraft('d')).toMatchObject(newer);
    const { environment: _, ...legacy } = draft;
    expect(() => store.putDraft(legacy, 2)).toThrow('environment protocol');
    expect(() => store.consumeDraft({ id: 'd', revision: 2 })).toThrow('accepted command identity');
    store.consumeDraft({ id: 'd', revision: 2 }, 'accepted');
    expect(store.getDraft('d')).toMatchObject({ text: '', environment: newer.environment, lastConsumption: { commandId: 'accepted', submittedRevision: 2 } });
    store.close(); store = new HostStore(root);
    expect(store.putDraft({ ...draft, environment: null }, 3).ok).toBe(true);
    expect(() => store.putDraft(legacy, 4)).toThrow('environment protocol');
    const database = new Database(join(root, 'state.sqlite'), { readonly: true });
    try { expect(database.query('PRAGMA user_version').get()).toEqual({ user_version: 5 }); } finally { database.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('actual host refuses old writers and premature environment execution while preserving a revisioned draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-environment-protocol-'));
  const source = join(root, 'source'), agentDirectory = join(root, 'agent'), dataDirectory = join(root, 'data');
  await mkdir(source); await mkdir(agentDirectory);
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const start = () => startHost({ dataDirectory, agentDirectory, discoveryDirectory: source, tailscale: false, port: 0,
      workerPath: join(import.meta.dir, 'omp-workers/fixtures/no-provider-worker.ts') });
    host = await start();
    const request = (path: string, body?: unknown, authenticated = true) => fetch(host!.connection.origin + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${host!.connection.token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const send = async (envelope: CommandEnvelope, version = 5): Promise<CommandResult> => {
      const response = await request(`/v${version}/commands`, envelope); expect(response.status).toBe(200); return response.json();
    };
    const added = await send({ id: 'project', command: { type: 'project.add', path: source } });
    if (!added.ok || !added.value || !('path' in added.value)) throw new Error('Project not added');
    const projectId = added.value.id;
    const config = { ...selection, projectId, configPath: join(added.value.path, '.agent-desktop/environments/dev.toml') };
    const draft: DraftInput = { id: 'new-conversation', projectId, text: 'Unsent environment prompt', model: null, environment: config,
      execution: { type: 'worktree', startingState: { type: 'working-tree' } } };
    const save: CommandEnvelope = { id: 'save', commandVersion: 5, command: { type: 'draft.put', draft, expectedRevision: 0 } };
    expect((await request('/v5/commands', save, false)).status).toBe(401);
    for (const version of [1, 2, 3, 4]) expect((await request(`/v${version}/commands`, save)).status).toBe(422);
    const result = await send(save); expect(result).toMatchObject({ ok: true, value: { ...draft, revision: 1 } });
    const { environment: _, ...legacy } = draft;
    expect(await send({ id: 'old-writer', command: { type: 'draft.put', draft: legacy, expectedRevision: 1 } }, 4))
      .toMatchObject({ ok: false, error: { code: 'ENVIRONMENT_PROTOCOL_REQUIRED' } });
    expect(await send({ id: 'old-consumer', command: { type: 'session.prompt', sessionId: 'does-not-exist', text: draft.text, draft: { id: draft.id, revision: 1 } } }, 4))
      .toMatchObject({ ok: false, error: { code: 'ENVIRONMENT_PROTOCOL_REQUIRED' } });
    // This milestone has not connected the resumable route yet: no silent fallback to ordinary creation.
    const create: CommandEnvelope = { id: 'create', commandVersion: 5, command: { type: 'session.create', projectId, worktree: { type: 'working-tree' },
      environment: config, draft: { id: draft.id, revision: 1 } } };
    expect(await send(create)).toMatchObject({ ok: false, error: { code: 'ENVIRONMENT_EXECUTION_UNAVAILABLE' } });
    expect(await readdir(source)).toEqual([]);
    await host.stop(); host = undefined; host = await start();
    expect(await send(save)).toEqual(result);
    const state = await (await request('/v1/state')).json() as HostState;
    expect(state.localEnvironments).toEqual({ configuration: true });
    expect(state.drafts).toMatchObject([{ ...draft, revision: 1 }]); expect(state.sessions).toHaveLength(0);
    expect(await readdir(source)).toEqual([]);
  } finally { await host?.stop(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
