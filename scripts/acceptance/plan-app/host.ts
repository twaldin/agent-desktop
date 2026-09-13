import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { CommandEnvelope, CommandResult, Project, SessionSummary } from '../../../packages/shared/src/protocol';
import { startControlledProvider } from './provider';
const root = resolve(process.argv[2]!);
if (process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, 'agent') || process.env.PI_DISABLE_DOTENV !== '1'
  || process.env.PATH?.split(delimiter)[0] !== join(root, 'bin') || await readFile(join(root, 'bin/tailscale'), 'utf8') !== '#!/bin/sh\nexit 1\n')
  throw new Error('Isolated dotenv-disabled plan fixture and explicit tailnet refusal required.');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Non-loopback fetch forbidden in plan host fixture.');
  return originalFetch(input, { ...init, redirect: 'error' });
}, { preconnect: () => {} }) as typeof fetch;
const { startHost } = await import('../../../apps/host/src/server');
const projectPath = join(root, 'project'), fixtureFile = join(projectPath, 'plan-proof.txt'), nonce = `PLAN_NATIVE_${crypto.randomUUID()}`;
for (const name of ['data', 'agent', 'project']) await mkdir(join(root, name), { recursive: true });
await writeFile(fixtureFile, nonce + '\n');
async function git(args: string[]) {
  const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Plan fixture',
    '-c', 'user.email=plan@example.invalid', '-c', 'commit.gpgSign=false', ...args], {
    cwd: projectPath, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Disposable plan Git preparation failed (${code}): ${stderr}`);
  return stdout.trim();
}
// Production task-location/worktree inspection needs a real Git context. Only
// the owned private project is initialized; no personal repository is touched.
await git(['init', '-b', 'main']);
await git(['add', '--', 'plan-proof.txt']);
await git(['commit', '-m', 'Disposable plan acceptance fixture']);
const gitReceipt = { root: await git(['rev-parse', '--show-toplevel']), head: await git(['rev-parse', 'HEAD']),
  branch: await git(['branch', '--show-current']), status: await git(['status', '--porcelain']) };
if (gitReceipt.root !== projectPath || !/^[a-f0-9]{40,64}$/.test(gitReceipt.head) || gitReceipt.branch !== 'main' || gitReceipt.status)
  throw new Error('The disposable plan Git fixture is not the expected clean owning repository.');
const provider = await startControlledProvider(root, nonce), model = { provider: 'plan-ui', id: 'controlled' };
await writeFile(join(root, 'agent/config.yml'), `retry:\n  enabled: false\nplan:\n  enabled: true\n  defaultOnStartup: true\ntools:\n  approvalMode: yolo\nmodelRoles:\n  default: [plan-ui/controlled]\n  plan: [plan-ui/controlled]\ndefaultThinkingLevel: off\n`);
await writeFile(join(root, 'agent/models.yml'), JSON.stringify({ providers: { 'plan-ui': {
  baseUrl: provider.origin + '/v1', api: 'openai-completions', auth: 'none', models: [{ id: model.id,
    name: 'Controlled plan HTTP fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
const host = await startHost({ dataDirectory: join(root, 'data'), agentDirectory: join(root, 'agent'), discoveryDirectory: projectPath,
  workerPath: resolve(import.meta.dir, 'worker.ts'), tailscale: false, port: 0 }).catch(async cause => {
    const drained = await Promise.allSettled([provider.stop()]);
    throw new AggregateError([cause, ...drained.flatMap(result => result.status === 'rejected' ? [result.reason] : [])], 'Plan fixture host startup failed.');
  });
async function drain() {
  const results = await Promise.allSettled([provider.stop(), host.stop()]);
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'Plan fixture provider/host drain failed.');
}
async function command(command: CommandEnvelope['command']) {
  const response = await fetch(`${host.connection.origin}/v19/commands`, { method: 'POST', headers: { Authorization: `Bearer ${host.connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: crypto.randomUUID(), commandVersion: 19, command } satisfies CommandEnvelope) });
  const result = await response.json() as CommandResult;
  if (!response.ok || !result.ok) throw new Error(`Fixture setup command failed: ${JSON.stringify(result)}`);
  return result.value;
}
try {
  const project = await command({ type: 'project.add', path: projectPath, name: 'Plan acceptance workspace' }) as Project;
  const sessions: Record<string, { id: string; sessionFile: string }> = {};
  for (const name of ['keep', 'fresh', 'refine', 'save']) {
    const session = await command({ type: 'session.create', projectId: project.id, model, approvalMode: 'yolo' }) as SessionSummary;
    await command({ type: 'session.rename', sessionId: session.id, title: `Plan ${name} acceptance` });
    sessions[name] = { id: session.id, sessionFile: session.sessionFile };
  }
  await writeFile(join(root, 'ready.json'), JSON.stringify({ connection: host.connection, context: { projectId: project.id, projectPath,
    sourceId: sessions.keep!.id, sourceFile: sessions.keep!.sessionFile, sessions, fixtureFile, nonce, model, git: gitReceipt } }), { mode: 0o600 });
  let stopping = false;
  async function stop() {
    if (stopping) return; stopping = true;
    try { await drain(); process.exit(0); } catch (cause) { console.error(cause); process.exit(1); }
  }
  process.on('SIGTERM', () => void stop());
  for await (const chunk of process.stdin) if (String(chunk).trim() === 'stop') await stop();
} catch (cause) {
  const drained = await Promise.allSettled([drain()]);
  throw new AggregateError([cause, ...drained.flatMap(result => result.status === 'rejected' ? [result.reason] : [])], 'Plan fixture setup or shutdown failed.');
}
