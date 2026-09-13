import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import type { CommandEnvelope, CommandResult, DesktopBridge, HostState } from '../../../packages/shared/src/protocol';
import type { SessionForkSnapshot } from '../../../packages/shared/src/session-fork';
import type { LocalConnection } from '../../../apps/host/src/paths';
import { requestHost } from '../../../apps/desktop/src/main/host-transport';
import { requestVersionedCommand } from '../../../apps/desktop/src/main/command-endpoints';

export interface ForkFixtureContext { projectId: string; projectPath: string; sourceId: string; sourceFile: string; standaloneId: string; tracked: string; untracked: string }
export async function startForkFixture(output?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-fork-app-')));
  const logs = output ?? join(root, 'logs'); await mkdir(logs, { recursive: true });
  const privateBin = join(root, 'bin'); await mkdir(privateBin, { mode: 0o700 });
  // Refuse the real discovery executable. This is a failure, not fabricated peers.
  await writeFile(join(privateBin, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const username = userInfo().username;
  const environment = { HOME: root, USER: username, LOGNAME: username, PATH: privateBin + delimiter + (process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'), TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_DISABLE_DOTENV: '1',
    AGENT_DESKTOP_NATIVE_TERMINALS: '0', AGENT_DESKTOP_DATA_DIR: join(root, 'data'), AGENT_DESKTOP_PROFILE_DIR: join(root, 'profile'), TERM: 'dumb' };
  const host = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'host.ts'), root], { cwd: root, env: environment,
    stdin: 'pipe', stdout: Bun.file(join(logs, 'host.log')), stderr: Bun.file(join(logs, 'host-errors.log')) });
  try {
    const deadline = Date.now() + 60_000;
    while (!await Bun.file(join(root, 'ready.json')).exists()) {
      if (host.exitCode !== null || Date.now() > deadline) throw new Error(`Fork fixture did not start; inspect ${logs}`);
      await Bun.sleep(50);
    }
    const { connection, context } = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) as { connection: LocalConnection; context: ForkFixtureContext };
    if (connection.pid !== host.pid || new URL(connection.origin).hostname !== '127.0.0.1') throw new Error('The Fork fixture host identity does not match its owned child.');
    const http = (path: string, body?: unknown) => requestHost(connection, path, body);
    const bridge: Pick<DesktopBridge, 'getState' | 'getSessionFork' | 'command'> = {
      getState: owner => { if (owner !== undefined && owner !== connection.hostId) throw new Error('Wrong fixture host.'); return http('/v1/state') as Promise<HostState>; },
      getSessionFork: (id, owner) => { if (owner !== undefined && owner !== connection.hostId) throw new Error('Wrong fixture host.'); return http(`/v1/sessions/${encodeURIComponent(id)}/fork-destinations`) as Promise<SessionForkSnapshot>; },
      command: (envelope, owner) => { if (owner !== undefined && owner !== connection.hostId) throw new Error('Wrong fixture host.'); return requestVersionedCommand(http, envelope) as Promise<CommandResult>; },
    };
    return { root, environment, connection, context, bridge,
      async command(command: CommandEnvelope['command']) { return bridge.command({ id: crypto.randomUUID(), commandVersion: 16, command }, connection.hostId); },
      async stop() {
        if (host.exitCode === null) { host.stdin.write('stop\n'); host.stdin.end(); }
        const timer = setTimeout(() => host.kill('SIGKILL'), 15_000), code = await host.exited; clearTimeout(timer);
        if (code !== 0) throw new Error(`Fork fixture cleanup failed (${code}); isolated root retained: ${root}`);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    if (host.exitCode === null) { host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 15_000); await host.exited; clearTimeout(timer); }
    throw cause;
  }
}
