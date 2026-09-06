import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeLocalEnvironment, type CommandEnvelope } from '@agent-desktop/shared';
import { startHost } from './server';
import { LocalEnvironmentStore } from './local-environments';

test('authenticated setup output and exact cancellation remain responsive during the original create', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-environment-cancel-'))), source = join(root, 'source'), agentDirectory = join(root, 'agent');
  await mkdir(source); await mkdir(agentDirectory);
  const git = (...args: string[]) => { const r = Bun.spawnSync(['git', '--no-optional-locks', '-C', source, ...args]); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString(); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Environment fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgSign', 'false'); git('config', 'core.hooksPath', join(root, 'no-hooks'));
  await writeFile(join(source, 'README'), 'source unchanged'); git('add', 'README'); git('commit', '-m', 'Fixture');
  const originalIndex = await readFile(join(source, '.git/index')), originalHead = git('rev-parse', 'HEAD');
  const saved = await new LocalEnvironmentStore(source).save({ expectedRevision: null, raw: serializeLocalEnvironment({ version: 1, name: 'Cancellation', setup: { script: 'export PRIVATE_SETUP_VALUE=not-in-status\nprintf SETUP_READY\nprintf ERROR_DETAIL >&2\nwhile :; do sleep 1; done' } }) });
  if (saved.type !== 'saved') throw new Error('Config failed');
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  const start = () => startHost({ dataDirectory: join(root, 'data'), agentDirectory, discoveryDirectory: source,
    workerPath: join(import.meta.dir, 'omp-workers/fixtures/no-provider-worker.ts'), tailscale: false, port: 0 });
  try {
    host = await start();
    const request = (path: string, body?: unknown, auth = true) => fetch(host!.connection.origin + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${host!.connection.token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const send = async (envelope: CommandEnvelope) => { const response = await request('/v5/commands', envelope); expect(response.status).toBe(200); return response.json(); };
    const project = (await send({ id: 'project', command: { type: 'project.add', path: source } })).value;
    await send({ id: 'draft', commandVersion: 5, command: { type: 'draft.put', expectedRevision: 0, draft: { id: 'new-conversation', text: 'Preserved pending prompt', projectId: project.id, model: null, execution: { type: 'worktree', startingState: { type: 'branch', branchName: 'main' } }, environment: { projectId: project.id, configPath: saved.configPath, revision: saved.revision } } } });
    let settled = false;
    const creation = send({ id: 'held-create', commandVersion: 5, command: { type: 'session.create', projectId: project.id, worktree: { type: 'branch', branchName: 'main' }, environment: { projectId: project.id, configPath: saved.configPath, revision: saved.revision }, draft: { id: 'new-conversation', revision: 1 } } }).then(result => { settled = true; return result; });
    const outputRequest = { target: { projectId: project.id }, query: { type: 'environment.output', preparationId: 'held-create' } };
    let output: any;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = await request('/v1/workspace/query', outputRequest);
      if (response.ok) output = (await response.json()).output;
      if (settled) throw new Error(`Create ended before live output: ${JSON.stringify(await creation)}`);
      if (output?.stdout === 'SETUP_READY' && output?.stderr === 'ERROR_DETAIL') break;
      await Bun.sleep(25);
    }
    expect(output).toMatchObject({ stdout: 'SETUP_READY', stderr: 'ERROR_DETAIL', finished: false, cancellationRequested: false });
    expect(settled).toBe(false);
    expect((await request('/v1/workspace/query', outputRequest, false)).status).toBe(401);
    expect((await request('/v1/workspace/query', { ...outputRequest, target: { projectId: 'foreign' } })).status).toBe(400);
    const stateText = await (await request('/v1/state')).text(); expect(stateText).not.toContain('SETUP_READY'); expect(stateText).not.toContain('not-in-status');
    const cancel: CommandEnvelope = { id: 'cancel', commandVersion: 5, command: { type: 'session.environment.cancel', preparationId: 'held-create', projectId: project.id, runRevision: output.runRevision } };
    expect((await request('/v4/commands', cancel)).status).toBe(422);
    expect((await request('/v5/commands', cancel, false)).status).toBe(401);
    expect(await send({ ...cancel, id: 'foreign-cancel', command: { ...cancel.command as Extract<CommandEnvelope['command'], { type: 'session.environment.cancel' }>, projectId: 'foreign' } })).toMatchObject({ ok: false });
    expect(await send({ ...cancel, id: 'stale-cancel', command: { ...cancel.command as Extract<CommandEnvelope['command'], { type: 'session.environment.cancel' }>, runRevision: output.runRevision - 1 } })).toMatchObject({ ok: false });
    expect(settled).toBe(false);
    const cancelled = await send(cancel); expect(cancelled).toMatchObject({ ok: true }); expect(await send(cancel)).toEqual(cancelled);
    expect(await creation).toMatchObject({ ok: true, value: { preparation: { phase: 'setup-failed', setup: { status: 'cancelled', cancelReason: 'aborted' } } } });
    const finished = (await (await request('/v1/workspace/query', outputRequest)).json()).output;
    expect(finished).toMatchObject({ stdout: 'SETUP_READY', finished: true, cancellationRequested: true });
    expect(finished.stderr.startsWith('ERROR_DETAIL')).toBe(true);
    expect(finished.stderr).toBe(host.store.environmentPreparations.get('held-create')?.setupResult?.stderr);
    expect(host.store.listSessions()).toHaveLength(0); expect(host.store.getDraft('new-conversation')?.text).toBe('Preserved pending prompt');
    await host.stop(); host = await start();
    expect((await (await request('/v1/workspace/query', outputRequest)).json()).output).toEqual(finished);
    expect(await send(cancel)).toEqual(cancelled);
    expect(await send({ ...cancel, id: 'no-live-owner' })).toMatchObject({ ok: false });
    expect(host.store.listSessions()).toHaveLength(0);
    expect(git('rev-parse', 'HEAD')).toBe(originalHead); expect(await readFile(join(source, '.git/index'))).toEqual(originalIndex);
  } finally { await host?.stop(); await rm(root, { recursive: true, force: true }); }
}, 25_000);
