import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceError, WorkspaceService } from './service';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
type Options = { validExitCodes?: number[]; signal?: AbortSignal; env?: NodeJS.ProcessEnv };
type Runner = { git(args: string[], options?: Options): Promise<{ stdout: string; exitCode: number }> };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'worktree-resolution-')); roots.push(root);
  const source = join(root, 'source'), remote = join(root, 'bare'), upstream = join(root, 'upstream');
  await mkdir(source); await mkdir(upstream);
  for (const cwd of [source, upstream]) {
    git(cwd, 'init', '--initial-branch=main');
    git(cwd, 'config', 'user.name', 'Starting ref fixture'); git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    git(cwd, 'config', 'commit.gpgSign', 'false'); git(cwd, 'config', 'core.hooksPath', join(root, 'no-hooks'));
  }
  await writeFile(join(source, 'tracked'), 'base\n'); git(source, 'add', 'tracked'); git(source, 'commit', '-m', 'base');
  const first = git(source, 'rev-parse', 'HEAD');
  git(source, 'clone', '--bare', source, remote); git(source, 'remote', 'add', 'origin', remote);
  git(upstream, 'remote', 'add', 'origin', remote); git(upstream, 'fetch', 'origin'); git(upstream, 'reset', '--hard', 'origin/main');
  const service = new WorkspaceService(source), runner = service as unknown as Runner;
  const original = runner.git.bind(service), calls: string[][] = [];
  runner.git = (args, options) => { calls.push([...args]); return original(args, { ...options, env }); };
  const checkpoint = async () => ({ index: await readFile(join(source, '.git/index')), head: await readFile(join(source, '.git/HEAD')),
    file: await readFile(join(source, 'tracked')), config: await readFile(join(source, '.git/config')) });
  const advance = async (branch = 'topic') => {
    git(upstream, 'checkout', '-B', branch); await writeFile(join(upstream, 'tracked'), `next ${crypto.randomUUID()}\n`);
    git(upstream, 'add', 'tracked'); git(upstream, 'commit', '-m', 'advance'); git(upstream, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    return git(upstream, 'rev-parse', 'HEAD');
  };
  return { root, source, remote, upstream, service, runner, original, calls, checkpoint, advance, first };
}

test('local HEAD, arbitrary revision, exact namespace and local branch precedence avoid remote calls', async () => {
  const f = await fixture(); git(f.source, 'tag', 'snapshot');
  // A shadow tag must not manufacture a vanished literal ref.
  git(f.source, 'tag', 'refs/heads/vanished');
  const before = await f.checkpoint();
  expect(await f.service.resolveWorktreeStartingRef('HEAD')).toEqual({ ref: 'HEAD' });
  expect(await f.service.resolveWorktreeStartingRef('@')).toEqual({ ref: '@' });
  expect(await f.service.resolveWorktreeStartingRef('main')).toEqual({ ref: 'refs/heads/main' });
  expect(await f.service.resolveWorktreeStartingRef('refs/heads/vanished')).toBeNull();
  expect(await f.service.resolveWorktreeStartingRef('snapshot^{commit}')).toEqual({ ref: f.first });
  expect(await f.service.resolveWorktreeStartingCommit({ type: 'branch', branchName: 'HEAD', remoteRef: 'refs/remotes/origin/topic' })).toBe(f.first);
  expect(f.calls.filter(args => ['fetch', 'ls-remote'].includes(args[0]!))).toHaveLength(0);
  expect(await f.checkpoint()).toEqual(before);
});

test('cached remote candidates precede any network and explicit creation refresh fetches the latest commit', async () => {
  const f = await fixture(); const initial = await f.advance();
  git(f.source, 'fetch', 'origin', '+refs/heads/topic:refs/remotes/origin/topic');
  // Origin is first, but all cached candidates must win before origin lookup.
  git(f.source, 'remote', 'add', 'backup', f.remote);
  git(f.source, 'update-ref', 'refs/remotes/backup/cached', f.first);
  const before = await f.checkpoint();
  expect(await f.service.resolveWorktreeStartingRef('cached')).toEqual({ ref: 'refs/remotes/backup/cached', remoteRef: 'refs/remotes/backup/cached' });
  const selected = await f.service.resolveWorktreeStartingRef('origin/topic');
  expect(selected).toEqual({ ref: 'refs/remotes/origin/topic', remoteRef: 'refs/remotes/origin/topic' });
  expect(f.calls.filter(args => ['fetch', 'ls-remote'].includes(args[0]!))).toHaveLength(0);
  const next = await f.advance(); expect(next).not.toBe(initial);
  expect(await f.service.resolveWorktreeStartingCommit({ type: 'branch', branchName: 'topic', remoteRef: selected!.remoteRef })).toBe(next);
  expect(git(f.source, 'rev-parse', 'refs/remotes/origin/topic')).toBe(next);
  expect(f.calls.filter(args => args[0] === 'fetch')).toEqual([['fetch', '--', 'origin', '+refs/heads/topic:refs/remotes/origin/topic']]);
  expect(await f.checkpoint()).toEqual(before);
});

test('missing remote candidate is validated then fetched, with a distinct second creation refresh', async () => {
  const f = await fixture(), next = await f.advance(); const before = await f.checkpoint();
  const resolved = await f.service.resolveWorktreeStartingRef('topic');
  expect(resolved).toEqual({ ref: 'refs/remotes/origin/topic', remoteRef: 'refs/remotes/origin/topic' });
  expect(f.calls.filter(args => args[0] === 'ls-remote')).toEqual([['ls-remote', '--exit-code', '--', 'origin', 'refs/heads/topic']]);
  expect(await f.service.resolveWorktreeStartingCommit({ type: 'branch', branchName: resolved!.ref, remoteRef: resolved!.remoteRef })).toBe(next);
  expect(f.calls.filter(args => args[0] === 'fetch')).toHaveLength(2);
  expect(await f.checkpoint()).toEqual(before);
});

test('upstream divergence chooses remote only for strictly right-ahead and never marks remoteRef', async () => {
  const f = await fixture(); git(f.source, 'fetch', 'origin'); git(f.source, 'branch', '--set-upstream-to=origin/main', 'main');
  expect(await f.service.resolveWorktreeStartingRef('main')).toEqual({ ref: 'refs/heads/main' });
  await f.advance('main'); git(f.source, 'fetch', 'origin');
  expect(await f.service.resolveWorktreeStartingRef('main')).toEqual({ ref: 'refs/remotes/origin/main' });
  await writeFile(join(f.source, 'local'), 'local\n'); git(f.source, 'add', 'local'); git(f.source, 'commit', '-m', 'local divergent');
  expect(await f.service.resolveWorktreeStartingRef('main')).toEqual({ ref: 'refs/heads/main' });
  git(f.source, 'update-ref', 'refs/remotes/origin/main', f.first);
  expect(await f.service.resolveWorktreeStartingRef('main')).toEqual({ ref: 'refs/heads/main' });
  expect(f.calls.filter(args => ['fetch', 'ls-remote'].includes(args[0]!))).toHaveLength(0);
});

test('lookup absence can continue, operational failures propagate, dispatched fetch failure is uncertain without fallback', async () => {
  const f = await fixture(); const next = await f.advance();
  expect(await f.service.resolveWorktreeStartingRef('absent')).toBeNull();
  expect(f.calls.filter(args => args[0] === 'fetch')).toHaveLength(0);
  git(f.source, 'remote', 'add', 'aaa', f.remote);
  git(f.source, 'remote', 'set-url', 'origin', join(f.root, 'missing-bare'));
  expect(await f.service.resolveWorktreeStartingRef('topic')).toEqual({ ref: 'refs/remotes/aaa/topic', remoteRef: 'refs/remotes/aaa/topic' });
  expect(git(f.source, 'rev-parse', 'refs/remotes/aaa/topic')).toBe(next);
  const calls: string[][] = [];
  f.runner.git = async (args, options) => {
    calls.push(args);
    if (args[0] === 'ls-remote') throw new WorkspaceError('GIT_TIMEOUT', 'controlled lookup timeout');
    return f.original(args, { ...options, env });
  };
  await expect(f.service.resolveWorktreeStartingRef('absent')).rejects.toMatchObject({ code: 'GIT_TIMEOUT' });
  expect(calls.filter(args => args[0] === 'ls-remote')).toHaveLength(1);
  calls.length = 0;
  f.runner.git = async (args, options) => {
    calls.push(args);
    if (args[0] === 'ls-remote') return { exitCode: 0, stdout: `${next}\trefs/heads/new\n` };
    if (args[0] === 'fetch') throw new WorkspaceError('GIT_TIMEOUT', 'controlled sent fetch timeout');
    return f.original(args, { ...options, env });
  };
  await expect(f.service.resolveWorktreeStartingRef('new')).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
  expect(calls.filter(args => args[0] === 'fetch')).toHaveLength(1);
  expect(calls.filter(args => args[0] === 'ls-remote')).toHaveLength(1);
});

test('cancellation stops before dispatch, and loss after sent fetch remains unknown', async () => {
  const f = await fixture(), cancelled = new AbortController(); cancelled.abort(new Error('cancelled-before-admission'));
  await expect(f.service.resolveWorktreeStartingRef('topic', cancelled.signal)).rejects.toThrow('cancelled-before-admission');
  expect(f.calls).toHaveLength(0);
  const pending = new AbortController();
  f.runner.git = async (args, options) => {
    if (args[0] === 'ls-remote') return { exitCode: 0, stdout: `${f.first}\trefs/heads/topic\n` };
    if (args[0] === 'fetch') { pending.abort(new Error('cancelled-after-dispatch')); throw pending.signal.reason; }
    return f.original(args, { ...options, env });
  };
  await expect(f.service.resolveWorktreeStartingRef('topic', pending.signal)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
});

test('explicit remote must still exist; nested remote uses longest configured prefix', async () => {
  const f = await fixture(); const next = await f.advance();
  // Newer Git refuses `remote add` for a slash-qualified name that overlaps an
  // existing remote, but older repositories can still contain this valid config.
  git(f.source, 'config', 'remote.origin/team.url', f.remote);
  git(f.source, 'config', 'remote.origin/team.fetch', '+refs/heads/*:refs/remotes/origin/team/*');
  expect(await f.service.resolveWorktreeStartingCommit({ type: 'branch', branchName: 'topic', remoteRef: 'refs/remotes/origin/team/topic' })).toBe(next);
  expect(f.calls.filter(args => args[0] === 'fetch')).toEqual([['fetch', '--', 'origin/team', '+refs/heads/topic:refs/remotes/origin/team/topic']]);
  git(f.source, 'config', '--remove-section', 'remote.origin/team'); git(f.source, 'remote', 'remove', 'origin');
  f.calls.length = 0;
  await expect(f.service.resolveWorktreeStartingCommit({ type: 'branch', branchName: 'topic', remoteRef: 'refs/remotes/origin/team/topic' })).rejects.toMatchObject({ code: 'REMOTE_CHANGED' });
  expect(f.calls.filter(args => args[0] === 'fetch')).toHaveLength(0);
});
