import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { appendWholeFile } from '../../../apps/desktop/src/renderer/whole-file-composer';
import type { CommandEnvelope, CommandResult, DraftInput, Project, SessionSummary } from '../../../packages/shared/src/protocol';
import { startHost } from '../../../apps/host/src/server';

const root = resolve(process.argv[2]!);
if (process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, 'agent') || process.env.PI_DISABLE_DOTENV !== '1'
  || process.env.PATH?.split(delimiter)[0] !== join(root, 'bin') || await readFile(join(root, 'bin/tailscale'), 'utf8') !== '#!/bin/sh\nexit 1\n')
  throw new Error('An isolated, dotenv-disabled Fork fixture with explicit tailnet refusal is required.');
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Outbound network is forbidden in the Fork fixture.');
  return originalFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;
const projectPath = join(root, 'project');
for (const name of ['data', 'agent', 'project', 'standalone']) await mkdir(join(root, name), { recursive: true });
await writeFile(join(root, 'agent/config.yml'), 'retry:\n  enabled: false\ntools:\n  approvalMode: always-ask\n');
async function git(args: string[]) {
  const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fork fixture', '-c', 'user.email=fork@example.invalid', ...args], { cwd: projectPath, stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(`Disposable Git preparation failed: ${error}`);
  return output;
}
await git(['init', '-b', 'main']);
await writeFile(join(projectPath, 'tracked.txt'), 'Committed fixture contents\n');
await git(['add', 'tracked.txt']); await git(['commit', '-m', 'Disposable fork fixture']);
await writeFile(join(projectPath, 'tracked.txt'), 'Retained source working-tree contents\n');
await writeFile(join(projectPath, 'untracked.txt'), 'Retained untracked source contents\n');
const options = { dataDirectory: join(root, 'data'), agentDirectory: join(root, 'agent'), discoveryDirectory: projectPath,
  workerPath: resolve(import.meta.dir, '../../../apps/host/src/omp-workers/fixtures/no-provider-worker.ts'), tailscale: false, port: 0 };
let host = await startHost(options);
async function command(command: CommandEnvelope['command']) {
  const response = await fetch(`${host.connection.origin}/v16/commands`, { method: 'POST', headers: { Authorization: `Bearer ${host.connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: crypto.randomUUID(), commandVersion: 16, command } satisfies CommandEnvelope) });
  const result = await response.json() as CommandResult;
  if (!response.ok || !result.ok) throw new Error(`Fixture command failed: ${JSON.stringify(result)}`);
  return result.value;
}
try {
  const project = await command({ type: 'project.add', path: projectPath, name: 'Fork workspace' }) as Project;
  const source = await command({ type: 'session.create', projectId: project.id }) as SessionSummary;
  const standalone = await command({ type: 'session.create', projectId: null, cwd: join(root, 'standalone') }) as SessionSummary;
  await host.stop();
  // Seed through the real native journal API while no process owns the file.
  // No provider or synthetic successful Fork result is involved.
  // The outbound guard must be installed before the SDK module-loading boundary.
  const { SessionManager } = await import('@oh-my-pi/pi-coding-agent');
  const manager = await SessionManager.open(source.sessionFile);
  manager.appendMessage({ role: 'user', content: 'First retained Fork history entry', timestamp: 1_700_000_000_000 });
  manager.appendMessage({ role: 'user', content: 'Second retained Fork history entry', timestamp: 1_700_000_001_000 });
  await manager.flush(); await manager.close();
  const artifacts = source.sessionFile.replace(/\.jsonl$/, '');
  await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, 'fork-proof.txt'), 'Native artifact retained across Fork\n');
  host = await startHost(options);
  await command({ type: 'session.rename', sessionId: source.id, title: 'Fork source' });
  await command({ type: 'session.rename', sessionId: standalone.id, title: 'Unprojected Fork source' });
  const draft: DraftInput = { id: `session:${source.id}`, projectId: project.id, text: 'Retained source draft', model: null, thinkingLevel: 'high', approvalMode: 'always-ask' };
  draft.wholeFileAttachments = appendWholeFile({ ...draft, revision: 0, updatedAt: 0 }, host.connection.hostId, { hostId: host.connection.hostId, path: join(projectPath, 'tracked.txt') }, { textOffset: 9 });
  await command({ type: 'draft.put', expectedRevision: 0, draft });
  await writeFile(join(root, 'ready.json'), JSON.stringify({ connection: host.connection, context: { projectId: project.id, projectPath, sourceId: source.id, sourceFile: source.sessionFile, standaloneId: standalone.id,
    tracked: await readFile(join(projectPath, 'tracked.txt'), 'utf8'), untracked: await readFile(join(projectPath, 'untracked.txt'), 'utf8') } }), { mode: 0o600 });
  let stopping = false;
  async function stop() { if (stopping) return; stopping = true; try { await host.stop(); process.exit(0); } catch (cause) { console.error(cause); process.exit(1); } }
  process.on('SIGTERM', () => void stop());
  for await (const chunk of process.stdin) if (String(chunk).trim() === 'stop') await stop();
} catch (cause) { await host.stop(); throw cause; }
