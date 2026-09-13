import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { WindowStateStore } from '../../../apps/desktop/src/main/window-state';
import { defaultWindowView } from '../../../apps/desktop/src/window-state';
import { createDockState } from '../../../apps/desktop/src/renderer/dock-state';
import type { LocalConnection } from '../../../apps/host/src/paths';

interface SurfaceConditions {
  name: string; responsive: boolean; bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number }; dpr: number; zoom: 1;
}
const repository = resolve(import.meta.dir, '../../..'), output = resolve(process.argv[2] ?? '.data/keyboard-reset-dialog-app');
if (process.platform !== 'darwin') throw new Error('Native reset-dialog acceptance requires macOS CG/AX inspection.');
for (const path of ['main.cjs', 'preload.cjs', 'renderer/index.html']) await access(join(repository, 'apps/desktop/dist', path));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Refusing to overwrite reset-dialog evidence.');
const conditions: SurfaceConditions = process.argv[3] ? JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')) : {
  name: 'reset-dialog-main-1440x1000', responsive: false, bounds: { x: 560, y: 180, width: 1440, height: 1000 },
  viewport: { width: 1440, height: 1000 }, dpr: 2, zoom: 1,
};
if (!conditions || !conditions.name || typeof conditions.responsive !== 'boolean' || !conditions.bounds || !conditions.viewport
  || !Object.values(conditions.bounds).every(Number.isSafeInteger) || conditions.bounds.width < 720 || conditions.bounds.height < 480
  || !Number.isSafeInteger(conditions.viewport.width) || !Number.isSafeInteger(conditions.viewport.height) || conditions.viewport.width <= 0 || conditions.viewport.height <= 0
  || !Number.isFinite(conditions.dpr) || conditions.dpr <= 0 || conditions.zoom !== 1) throw new Error('Invalid native surface conditions.');
if (!conditions.responsive && (conditions.bounds.width !== 1440 || conditions.bounds.height !== 1000 || conditions.viewport.width !== 1440 || conditions.viewport.height !== 1000 || conditions.dpr !== 2))
  throw new Error('Different geometry must be a separately named intentional responsive case.');
await writeFile(join(output, 'surface-conditions.json'), JSON.stringify(conditions, null, 2));
const sources = ['apps/desktop/src/renderer/keyboard-shortcuts-settings.css', 'apps/desktop/src/renderer/KeyboardShortcutsSettings.tsx', 'apps/desktop/src/renderer/command-keymap-state.ts',
  'apps/desktop/src/renderer/App.tsx', 'apps/desktop/src/renderer/styles.css', 'apps/desktop/src/renderer/theme.css',
  ...['host.ts', 'run.ts', 'main.cjs', 'surface-guard.cjs', 'capture-state.cjs', 'geometry.swift'].map(name => `scripts/acceptance/keyboard-reset-dialog-app/${name}`)];
// Bind the exact built renderer carrying the CSS, not just main/preload.
async function builtFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Built renderer evidence must not follow symbolic links.');
    if (entry.isDirectory()) result.push(...await builtFiles(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}
sources.push('apps/desktop/dist/main.cjs', 'apps/desktop/dist/preload.cjs', ...await builtFiles('apps/desktop/dist/renderer'));
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(join(repository, path))).digest('hex')])));
const before = await hashes(); await writeFile(join(output, 'source-before.json'), JSON.stringify(before, null, 2));
const compiler = Bun.spawn(['/usr/bin/xcrun', 'swiftc', join(import.meta.dir, 'geometry.swift'), '-o', join(output, 'native-geometry')], {
  env: { HOME: output, PATH: process.env.PATH, TMPDIR: tmpdir(), CLANG_MODULE_CACHE_PATH: join(output, 'swift-module-cache') },
  stdout: Bun.file(join(output, 'geometry-build.log')), stderr: Bun.file(join(output, 'geometry-build-errors.log')),
});
if (await compiler.exited !== 0) throw new Error('Native inspector compilation failed before host/App startup.');
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-reset-dialog-'))), privateBin = join(fixture, 'bin');
await mkdir(privateBin, { mode: 0o700 }); await writeFile(join(privateBin, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const username = userInfo().username;
const environment = { HOME: fixture, USER: username, LOGNAME: username, PATH: privateBin + delimiter + (process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'), TMPDIR: tmpdir(), PI_DISABLE_DOTENV: '1',
  PI_CODING_AGENT_DIR: join(fixture, 'agent'), AGENT_DESKTOP_DATA_DIR: join(fixture, 'data'), AGENT_DESKTOP_PROFILE_DIR: join(fixture, 'profile'), AGENT_DESKTOP_NATIVE_TERMINALS: '0', TERM: 'dumb' };
const host = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'host.ts'), fixture], { cwd: fixture, env: environment,
  stdin: 'pipe', stdout: Bun.file(join(output, 'host.log')), stderr: Bun.file(join(output, 'host-errors.log')) });
let electron: Bun.Subprocess | undefined;
try {
  const deadline = Date.now() + 60_000;
  while (!await Bun.file(join(fixture, 'ready.json')).exists()) {
    if (host.exitCode !== null || Date.now() > deadline) throw new Error('Reset fixture host did not become ready.');
    await Bun.sleep(50);
  }
  const { connection } = JSON.parse(await readFile(join(fixture, 'ready.json'), 'utf8')) as { connection: LocalConnection };
  if (connection.pid !== host.pid || new URL(connection.origin).hostname !== '127.0.0.1') throw new Error('Wrong isolated host identity.');
  const profile = join(fixture, 'profile'), candidate = join(output, 'candidate-app');
  await mkdir(profile, { recursive: true }); await mkdir(candidate);
  const state = new WindowStateStore(profile, 'primary');
  const saved = state.saveView({ ...defaultWindowView(), route: { hostId: connection.hostId, sessionId: null }, settingsOpen: true, settingsPage: 'keyboard-shortcuts', workspaceOpen: false,
    dock: { tabs: [], state: { ...createDockState(), right: { tabIds: [], open: false } } } });
  if (saved.error) throw new Error(saved.error);
  await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'agent-desktop-reset-dialog-acceptance', version: '0.0.0', main: 'main.cjs' }));
  for (const name of ['main.cjs', 'surface-guard.cjs', 'capture-state.cjs']) await copyFile(join(import.meta.dir, name), join(candidate, name));
  await symlink(join(repository, 'apps/desktop/dist'), join(candidate, 'dist'), 'dir');
  electron = Bun.spawn([process.execPath, join(repository, 'node_modules/electron/cli.js'), candidate, output, fixture, repository], {
    cwd: fixture, env: { ...environment, AGENT_DESKTOP_PROJECT_ROOT: repository, AGENT_DESKTOP_BUN: process.execPath },
    stdout: Bun.file(join(output, 'electron.log')), stderr: Bun.file(join(output, 'electron-errors.log')),
  });
  const timer = setTimeout(() => electron!.kill('SIGTERM'), 180_000), code = await electron.exited; clearTimeout(timer);
  if (code !== 0) throw new Error(`Reset-dialog acceptance is RED (${code}); inspect ${output}/result.json.`);
  if (!JSON.parse(await readFile(join(output, 'result.json'), 'utf8')).passed) throw new Error('Reset-dialog acceptance did not pass.');
} finally {
  if (electron?.exitCode === null) { electron.kill('SIGTERM'); await electron.exited; }
  if (host.exitCode === null) { host.stdin.write('stop\n'); host.stdin.end(); }
  const timer = setTimeout(() => host.kill('SIGKILL'), 15_000), code = await host.exited; clearTimeout(timer);
  const after = await hashes(); await writeFile(join(output, 'source-after.json'), JSON.stringify(after, null, 2));
  if (code === 0) await rm(fixture, { recursive: true, force: true });
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({ hostExit: code, electronExit: electron?.exitCode, fixtureRemoved: code === 0, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after) }));
  if (code !== 0 || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Reset fixture cleanup or source freeze failed.');
}
