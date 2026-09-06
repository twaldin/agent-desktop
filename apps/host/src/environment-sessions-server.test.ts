import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeLocalEnvironment, type CommandEnvelope, type CommandResult, type DraftInput, type LocalEnvironmentPreparationPublic } from '@agent-desktop/shared';
import { startHost } from './server';
import { LocalEnvironmentStore } from './local-environments';

test('authenticated create/resume/reopen/cleanup use actual Git, sourced setup and native OMP without a prompt', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-environment-native-server-')));
  const source = join(root, 'source'), dataDirectory = join(root, 'data'), agentDirectory = join(root, 'agent');
  await mkdir(source); await mkdir(agentDirectory);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '--no-optional-locks', '-C', source, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Environment fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgSign', 'false'); git('config', 'core.hooksPath', join(root, 'no-hooks'));
  await writeFile(join(source, 'README.md'), 'original source\n'); git('add', 'README.md'); git('commit', '-m', 'Initial');
  const original = { head: git('rev-parse', 'HEAD'), index: await readFile(join(source, '.git/index')), file: await readFile(join(source, 'README.md')) };
  const saved = await new LocalEnvironmentStore(source).save({ expectedRevision: null, raw: serializeLocalEnvironment({ version: 1, name: 'Native environment',
    setup: { script: "printf 'attempt\\n' >> setup-attempts\n[ -f allow ]\nexport ENVIRONMENT_ROUTE_CHECK=private-fixture-export" },
    cleanup: { script: 'rm -f setup-attempts allow\n[ ! -f block-cleanup ]' } }) });
  if (saved.type !== 'saved') throw new Error('Config not saved');
  const observations = join(root, 'worker-observations.jsonl'), workerPath = join(root, 'worker.ts');
  await writeFile(workerPath, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(observations)}, JSON.stringify({value:process.env.ENVIRONMENT_ROUTE_CHECK??null,cwd:process.env.AGENT_WORKTREE_PATH??null})+'\\n');\nawait import(${JSON.stringify(join(import.meta.dir, 'omp-workers/fixtures/no-provider-worker.ts'))});\n`);
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const start = () => startHost({ dataDirectory, agentDirectory, workerPath, discoveryDirectory: source, port: 0, tailscale: false });
    host = await start();
    const request = (path: string, body?: unknown, authorized = true) => fetch(host!.connection.origin + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${host!.connection.token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const send = async (command: CommandEnvelope): Promise<CommandResult> => { const response = await request('/v5/commands', command); expect(response.status).toBe(200); return response.json(); };
    const added = await send({ id: 'project', command: { type: 'project.add', path: source } });
    if (!added.ok || !added.value || !('path' in added.value)) throw new Error('Missing project');
    const projectId = added.value.id;
    const draft: DraftInput = { id: 'new-conversation', text: 'Unsent original prompt', projectId, model: null,
      execution: { type: 'worktree', startingState: { type: 'branch', branchName: 'main' } },
      environment: { projectId, configPath: saved.configPath, revision: saved.revision } };
    expect(await send({ id: 'save', commandVersion: 5, command: { type: 'draft.put', draft, expectedRevision: 0 } })).toMatchObject({ ok: true });
    const create: CommandEnvelope = { id: 'create-environment', commandVersion: 5, command: { type: 'session.create', projectId,
      worktree: { type: 'branch', branchName: 'main' }, environment: draft.environment, draft: { id: draft.id, revision: 1 } } };
    const failed = await send(create);
    if (!failed.ok || !failed.value || !('type' in failed.value) || failed.value.type !== 'environment.preparation') throw new Error(`Expected setup failure receipt: ${JSON.stringify(failed)}`);
    let prep = failed.value.preparation;
    expect(prep.phase).toBe('setup-failed'); expect(prep.setup?.exitCode).not.toBe(0);
    expect(host.store.listSessions()).toHaveLength(0);
    expect(await readFile(join(prep.worktreePath, 'setup-attempts'), 'utf8')).toBe('attempt\n');
    expect(await send(create)).toEqual(failed);
    expect(await readFile(join(prep.worktreePath, 'setup-attempts'), 'utf8')).toBe('attempt\n');
    const readPrep = () => request(`/v5/environment-preparations/${prep.id}`);
    expect((await request(`/v5/environment-preparations/${prep.id}`, undefined, false)).status).toBe(401);
    expect(await (await readPrep()).json()).toEqual(prep);
    expect(JSON.stringify(failed)).not.toContain('private-fixture-export');
    // A newer edit must not replace the captured setup or get consumed by recovery.
    expect(await send({ id: 'newer-edit', commandVersion: 5, command: { type: 'draft.put', draft: { ...draft, text: 'Newer preserved prompt', environment: null }, expectedRevision: 1 } })).toMatchObject({ ok: true });
    expect(await send({ id: 'stale-resume', commandVersion: 5, command: { type: 'session.environment.resume', preparationId: prep.id, expectedRevision: prep.revision - 1 } }))
      .toMatchObject({ ok: false, error: { code: 'ENVIRONMENT_PREPARATION_CONFLICT' } });
    await writeFile(join(prep.worktreePath, 'allow'), '');
    // Simulate loss of the first state publication after the native receipt commits.
    // The reply must still use the durable success, not a new failure or another worker.
    const appendEvent = host.store.appendEvent.bind(host.store);
    let notificationFailed = false;
    host.store.appendEvent = input => {
      if (!notificationFailed && host!.store.environmentPreparations.get(prep.id)?.phase === 'session-created') {
        notificationFailed = true; throw new Error('Injected post-commit state publication failure');
      }
      return appendEvent(input);
    };
    const resume: CommandEnvelope = { id: 'explicit-retry', commandVersion: 5, command: { type: 'session.environment.resume', preparationId: prep.id, expectedRevision: prep.revision } };
    const resumed = await send(resume);
    if (!resumed.ok || !resumed.value || !('sessionFile' in resumed.value)) throw new Error(`Native session not created: ${JSON.stringify(resumed)}`);
    const session = resumed.value;
    expect(notificationFailed).toBe(true);
    expect(session.cwd).toBe(prep.worktreePath); expect(session.status).toBe('idle');
    expect(await send(resume)).toEqual(resumed);
    expect(await readFile(join(session.cwd, 'setup-attempts'), 'utf8')).toBe('attempt\nattempt\n');
    expect(host.store.listSessions()).toHaveLength(1);
    await host.stop(); host = undefined; host = await start();
    expect(await send(resume)).toEqual(resumed);
    const messages = await (await request(`/v1/sessions/${session.id}/messages`)).json();
    expect(messages.filter((item: { role: string }) => item.role === 'user')).toHaveLength(0);
    const rows = (await readFile(observations, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.value === 'private-fixture-export')).toEqual([
      { value: 'private-fixture-export', cwd: session.cwd }, { value: 'private-fixture-export', cwd: session.cwd },
    ]);
    expect(process.env.ENVIRONMENT_ROUTE_CHECK).toBeUndefined();
    prep = await (await readPrep()).json() as LocalEnvironmentPreparationPublic;
    expect(prep.phase).toBe('session-created'); expect(JSON.stringify(prep)).not.toContain('private-fixture-export');
    const listing = await (await request('/v1/workspace/query', { target: { projectId }, query: { type: 'git.worktrees' } })).json();
    const managed = listing.worktrees.find((tree: { path: string }) => tree.path === session.cwd);
    await writeFile(join(session.cwd, 'block-cleanup'), '');
    const remove = (id: string) => send({ id, command: { type: 'workspace.mutate', target: { projectId }, action: { type: 'worktree.remove', path: managed.managedRelativePath } } });
    expect(await remove('failed-remove')).toMatchObject({ ok: false });
    expect(await readFile(join(session.cwd, 'README.md'))).toEqual(original.file);
    expect(host.store.getSessionEnvironment(session.id)?.environmentDelta?.set.ENVIRONMENT_ROUTE_CHECK).toBe('private-fixture-export');
    expect((await (await readPrep()).json()).phase).toBe('cleanup-failed');
    await rm(join(session.cwd, 'block-cleanup'));
    expect(await remove('explicit-remove')).toMatchObject({ ok: true });
    expect((await (await readPrep()).json()).phase).toBe('removed');
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(host.store.getDraft(draft.id)).toMatchObject({ text: 'Newer preserved prompt', environment: null, revision: 2 });
    expect(git('rev-parse', 'HEAD')).toBe(original.head); expect(await readFile(join(source, '.git/index'))).toEqual(original.index);
    expect(await readFile(join(source, 'README.md'))).toEqual(original.file);
  } finally { await host?.stop(); await rm(root, { recursive: true, force: true }); }
}, 40_000);
