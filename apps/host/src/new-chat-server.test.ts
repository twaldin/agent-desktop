import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CommandEnvelope, CommandResult, HostState, SessionSummary } from '@agent-desktop/shared';
import { startHost } from './server';
import { HostStore } from './store';

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trimEnd();
}

test('owning host creates one native session in its selected worktree; retries and old endpoints cannot change its intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-new-chat-'));
  const project = join(root, 'project'), dataDirectory = join(root, 'data'), agentDirectory = join(root, 'agent');
  await Promise.all([project, agentDirectory].map(path => mkdir(path)));
  git(project, 'init', '--initial-branch=main');
  git(project, 'config', 'user.name', 'Worktree fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  git(project, 'config', 'commit.gpgSign', 'false'); git(project, 'config', 'core.hooksPath', join(root, 'no-hooks'));
  await writeFile(join(project, 'file.txt'), 'committed\n'); git(project, 'add', '.'); git(project, 'commit', '-m', 'Fixture');
  await writeFile(join(project, 'file.txt'), 'local edits stay here\n');
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    host = await startHost({ dataDirectory, agentDirectory, discoveryDirectory: project, tailscale: false, port: 0 });
    const request = (path: string, body?: unknown) => fetch(host!.connection.origin + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${host!.connection.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const send = async (envelope: CommandEnvelope, version = 4): Promise<CommandResult> => {
      const response = await request(`/v${version}/commands`, envelope); expect(response.status).toBe(200); return response.json();
    };
    const added = await send({ id: 'project', command: { type: 'project.add', path: project } });
    if (!added.ok || !added.value || !('path' in added.value)) throw new Error('Project was not added');
    const projectId = added.value.id;
    const draft = { id: 'new-conversation', projectId, text: 'Unsent snapshot', model: null, execution: { type: 'worktree' as const, startingState: { type: 'branch' as const, branchName: 'main' } } };
    const save: CommandEnvelope = { id: 'save', command: { type: 'draft.put', draft, expectedRevision: 0 } };
    expect((await request('/v3/commands', save)).status).toBe(422);
    expect((await send(save)).ok).toBe(true);
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    const legacy = { ...draft }; delete (legacy as { execution?: unknown }).execution;
    expect(await send({ id: 'legacy', command: { type: 'draft.put', draft: legacy, expectedRevision: 1 } }, 3)).toMatchObject({ ok: false, error: { code: 'NEW_CHAT_PROTOCOL_REQUIRED' } });
    const create: CommandEnvelope = { id: 'create/same-identity', commandVersion: 4, command: { type: 'session.create', projectId, worktree: draft.execution.startingState } };
    expect((await request('/v3/commands', create)).status).toBe(422);
    const result = await send(create);
    if (!result.ok || !result.value || !('sessionFile' in result.value)) throw new Error(`Native creation failed: ${JSON.stringify(result)}`);
    const session = result.value as SessionSummary;
    expect(session.cwd).not.toBe(project); expect(session.projectId).toBe(projectId);
    expect(session.status).toBe('idle'); expect(git(session.cwd, 'status', '--porcelain')).toBe('');
    expect(git(session.cwd, 'rev-parse', 'HEAD')).toBe(git(project, 'rev-parse', 'HEAD'));
    expect(await readFile(join(session.cwd, 'file.txt'), 'utf8')).toBe('committed\n');
    expect(await readFile(join(project, 'file.txt'), 'utf8')).toBe('local edits stay here\n');
    expect(await send(create)).toEqual(result);
    expect((await (await request('/v1/state')).json() as HostState).sessions).toHaveLength(1);
    expect((await (await request('/v1/state')).json() as HostState).drafts[0]).toMatchObject({ ...draft, revision: 1 });
    await host.stop(); host = undefined;
    host = await startHost({ dataDirectory, agentDirectory, discoveryDirectory: project, tailscale: false, port: 0 });
    expect(await send(create)).toEqual(result);
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2);
    expect((await (await request('/v1/state')).json() as HostState).sessions).toHaveLength(1);
  } finally { await host?.stop(); await rm(root, { recursive: true, force: true }); }
}, 40_000);

test('execution draft format stays sticky through conflicts, consumption and reopen without schema downgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-execution-draft-'));
  let store = new HostStore(root);
  try {
    const draft = { id: 'new-conversation', text: 'keep', projectId: 'p', model: null, execution: { type: 'worktree' as const, startingState: { type: 'working-tree' as const } } };
    expect(store.putDraft(draft, 0).ok).toBe(true);
    expect(store.putDraft({ ...draft, execution: { type: 'local' } }, 0).ok).toBe(false);
    expect(store.listDraftConflicts()[0]?.attempted.execution).toEqual({ type: 'local' });
    expect(() => store.consumeDraft({ id: draft.id, revision: 1 })).toThrow("accepted command identity");
    store.consumeDraft({ id: draft.id, revision: 1 }, "accepted-command");
    expect(store.getDraft(draft.id)).toMatchObject({ text: '', execution: draft.execution });
    const { execution, ...old } = draft;
    expect(() => store.putDraft(old, 2)).toThrow('execution protocol');
    store.close(); store = new HostStore(root);
    expect(store.putDraft({ ...draft, execution: { type: 'local' } }, 2).ok).toBe(true);
    const db = new Database(join(root, 'state.sqlite'), { readonly: true });
    try { expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 4 }); } finally { db.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
