import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import type { LocalConnection } from '../../../apps/host/src/paths';

export interface ForceFixtureContext {
  projectId: string; projectPath: string; sourceId: string; sourceFile: string;
  sessions: Record<string, { id: string; sessionFile: string }>;
  fixtureFile: string; nonce: string; model: { provider: string; id: string };
  git: { root: string; head: string; branch: string; status: string };
}
export async function startForceFixture(output?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-force-tool-app-')));
  const logs = output ?? join(root, 'logs'); await mkdir(logs, { recursive: true });
  const privateBin = join(root, 'bin'); await mkdir(privateBin, { mode: 0o700 });
  // Refuse the real discovery executable. This is a failure, not fabricated peers.
  await writeFile(join(privateBin, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const username = userInfo().username;
  const environment = { HOME: root, USER: username, LOGNAME: username, PATH: privateBin + delimiter + (process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'), TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_DISABLE_DOTENV: '1',
    AGENT_DESKTOP_NATIVE_TERMINALS: '0', AGENT_DESKTOP_DATA_DIR: join(root, 'data'), AGENT_DESKTOP_PROFILE_DIR: join(root, 'profile'), TERM: 'dumb', FORCE_TOOL_FIXTURE_ROOT: root };
  const host = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'host.ts'), root], { cwd: root, env: environment,
    stdin: 'pipe', stdout: Bun.file(join(logs, 'host.log')), stderr: Bun.file(join(logs, 'host-errors.log')) });
  try {
    const deadline = Date.now() + 60_000;
    while (!await Bun.file(join(root, 'ready.json')).exists()) {
      if (host.exitCode !== null || Date.now() > deadline) throw new Error(`Force fixture did not start; inspect ${logs}`);
      await Bun.sleep(50);
    }
    const { connection, context } = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) as { connection: LocalConnection; context: ForceFixtureContext };
    if (connection.pid !== host.pid || new URL(connection.origin).hostname !== '127.0.0.1') throw new Error('The Force fixture host identity does not match its owned child.');
    return { root, environment, connection, context,
      async stop() {
        if (host.exitCode === null) { host.stdin.write('stop\n'); host.stdin.end(); }
        const timer = setTimeout(() => host.kill('SIGKILL'), 15_000), code = await host.exited; clearTimeout(timer);
        if (code !== 0) throw new Error(`Force fixture cleanup failed (${code}); isolated root retained: ${root}`);
        await Bun.write(join(logs, 'fixture-evidence.json'), JSON.stringify({ context, hostPid: host.pid, stopped: true }));
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    if (host.exitCode === null) { host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 15_000); await host.exited; clearTimeout(timer); }
    throw cause;
  }
}
