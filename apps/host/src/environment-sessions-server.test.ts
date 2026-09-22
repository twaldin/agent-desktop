import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
    const start = () => startHost({ dataDirectory, agentDirectory, workerPath, discoveryDirectory: source, port: 0, tailscale: false, ...(process.env.AGENT_TEST_TMUX_BUNDLE ? { nativeTerminalBundle: process.env.AGENT_TEST_TMUX_BUNDLE } : {}) });
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
    const queryPreparation = (target: { projectId: string } | { sessionId: string }, authorized = true) => request('/v1/workspace/query', { target, query: { type: 'environment.preparation', preparationId: prep.id } }, authorized);
    expect((await queryPreparation({ projectId }, false)).status).toBe(401);
    expect(await (await queryPreparation({ projectId })).json()).toEqual({ type: 'environment.preparation', preparation: prep });
    const foreignPath = join(root, 'foreign'); await mkdir(foreignPath);
    const foreign = await send({ id: 'foreign-project', command: { type: 'project.add', path: foreignPath } });
    if (!foreign.ok || !foreign.value || !('path' in foreign.value)) throw new Error('Foreign fixture not added');
    expect((await queryPreparation({ projectId: foreign.value.id })).status).toBe(400);
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
    expect(await (await queryPreparation({ sessionId: session.id })).json()).toMatchObject({ type: 'environment.preparation', preparation: { id: prep.id, sessionId: session.id, phase: 'session-created' } });
    expect(session.cwd).toBe(prep.worktreePath); expect(session.status).toBe('idle');
    expect(await send(resume)).toEqual(resumed);
    expect(await readFile(join(session.cwd, 'setup-attempts'), 'utf8')).toBe('attempt\nattempt\n');
    expect(host.store.listSessions()).toHaveLength(1);
    const terminalVersions = process.env.AGENT_TEST_TMUX_BUNDLE ? ['v1', 'v2'] : ['v1'];
    const terminalEnvironment = async (version: string, target: { sessionId: string } | { projectId: string }, cwd: string, name: string, expected: string) => {
      const action = async (body: unknown) => {
        const response = await request(`/${version}/terminals/action`, body); expect(response.status).toBe(200); return response.json();
      };
      const created = await action({ type: 'create', options: { target } });
      expect(JSON.stringify(created)).not.toContain('private-fixture-export');
      expect(created.terminal.cwd).toBe(cwd);
      const filename = `terminal-${version}-${name}.txt`;
      const command = `printf '%s\\n' "\${ENVIRONMENT_ROUTE_CHECK-unset}" "\${AGENT_WORKTREE_PATH-unset}" > ${filename}`;
      try {
        if (version === 'v1') {
          const input = await request('/v1/terminals/input', { terminalId: created.terminal.id, clientId: crypto.randomUUID(), sequence: 1, data: `${command}\r` });
          expect(input.status).toBe(200); expect((await input.json()).accepted).toBe(true);
        } else {
          const attached = await action({ type: 'attach', terminalId: created.terminal.id, viewerId: crypto.randomUUID() });
          const attachment = attached.attachment;
          await action({ type: 'heartbeat', attachmentId: attachment.id, afterSequence: 0, geometryRevision: attachment.geometryRevision });
          const input = { terminalId: created.terminal.id, attachmentId: attachment.id, inputEpoch: attachment.inputEpoch, geometryRevision: attachment.geometryRevision, clientId: crypto.randomUUID() };
          for (const [index, key] of [{ kind: 'text', data: command }, { kind: 'key', key: 'Enter' }].entries()) {
            const response = await request('/v2/terminals/input', { ...input, sequence: index + 1, input: key });
            expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ outcome: 'accepted' });
          }
        }
        // printf can expose its first newline before writing the second value.
        const expectedOutput = `${expected}\n${'sessionId' in target ? session.cwd : 'unset'}\n`;
        const deadline = Date.now() + 8_000;
        let actual = '';
        while (Date.now() < deadline) {
          actual = await readFile(join(cwd, filename), 'utf8').catch(() => '');
          if (actual === expectedOutput) break;
          await Bun.sleep(25);
        }
        expect(actual).toBe(expectedOutput);
      } finally { await action({ type: 'close', terminalId: created.terminal.id }); await rm(join(cwd, filename), { force: true }); }
    };
    for (const version of terminalVersions) {
      await terminalEnvironment(version, { sessionId: session.id }, session.cwd, 'before-restart', 'private-fixture-export');
      await terminalEnvironment(version, { projectId }, source, 'project-isolated', 'unset');
    }
    await host.stop(); host = undefined; host = await start();
    expect(await send(resume)).toEqual(resumed);
    for (const version of terminalVersions) await terminalEnvironment(version, { sessionId: session.id }, session.cwd, 'after-restart', 'private-fixture-export');
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
    const snapshotRef = `refs/agent-desktop/snapshots/${createHash('sha1').update(session.cwd).digest('hex')}`;
    await writeFile(join(session.cwd, 'block-cleanup'), '');
    const remove = (id: string) => send({ id, command: { type: 'workspace.mutate', target: { projectId }, action: { type: 'worktree.remove', path: managed.managedRelativePath } } });
    expect(await remove('failed-remove')).toMatchObject({ ok: false });
    expect(await readFile(join(session.cwd, 'README.md'))).toEqual(original.file);
    expect(host.store.getSessionEnvironment(session.id)?.environmentDelta?.set.ENVIRONMENT_ROUTE_CHECK).toBe('private-fixture-export');
    expect((await (await readPrep()).json()).phase).toBe('cleanup-failed');
    expect(host.store.getSession(session.id)?.archived).toBe(false);
    expect(git('show', `${snapshotRef}:setup-attempts`)).toBe('attempt\nattempt\n');
    expect(git('show', `${snapshotRef}:block-cleanup`)).toBe('');
    await rm(join(session.cwd, 'block-cleanup'));
    const materialized = host.store.environmentPreparations.get(prep.id)!.environment!;
    expect(await readFile(materialized.configPath, 'utf8')).toBe(materialized.raw);
    expect(await remove('explicit-remove')).toMatchObject({ ok: true });
    expect(git('show', `${snapshotRef}:${materialized.configPath.slice(session.cwd.length + 1)}`)).toBe(materialized.raw);
    expect((await (await readPrep()).json()).phase).toBe('removed');
    expect(host.store.getSession(session.id)?.archived).toBe(true);
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(host.store.getDraft(draft.id)).toMatchObject({ text: 'Newer preserved prompt', environment: null, revision: 2 });
    expect(git('rev-parse', 'HEAD')).toBe(original.head); expect(await readFile(join(source, '.git/index'))).toEqual(original.index);
    expect(await readFile(join(source, 'README.md'))).toEqual(original.file);
  } finally { await host?.stop(); await rm(root, { recursive: true, force: true }); }
}, 40_000);
