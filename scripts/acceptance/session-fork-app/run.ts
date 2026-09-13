import { access, copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startForkFixture } from './fixture';
import { WindowStateStore } from '../../../apps/desktop/src/main/window-state';
import { defaultWindowView } from '../../../apps/desktop/src/window-state';
import { createDockState } from '../../../apps/desktop/src/renderer/dock-state';

interface SurfaceConditions {
  name: string; responsive: boolean; bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number }; dpr: number; zoom: 1;
}
const repository = resolve(import.meta.dir, '../../..'), output = resolve(process.argv[2] ?? '.data/session-fork-app-acceptance');
// Main supplies the coordinated build and owns the native-input lease. This
// runner never rebuilds the project or changes an installed/personal profile.
await access(join(repository, 'apps/desktop/dist/main.cjs'));
await access(join(repository, 'apps/desktop/dist/preload.cjs'));
await access(join(repository, 'apps/desktop/dist/renderer/index.html'));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Refusing to overwrite prior Fork acceptance evidence.');
if (process.platform !== 'darwin') throw new Error('This Fork native surface fixture requires macOS CG/AX inspection.');
const conditions: SurfaceConditions = process.argv[3] ? JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')) : {
  name: 'fixed-main-window-1440x1000', responsive: false, bounds: { x: 560, y: 180, width: 1440, height: 1000 },
  viewport: { width: 1440, height: 1000 }, dpr: 2, zoom: 1,
};
if (!conditions || typeof conditions.name !== 'string' || !conditions.name || typeof conditions.responsive !== 'boolean' || !conditions.bounds || !conditions.viewport
  || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(conditions.bounds[key as keyof SurfaceConditions['bounds']]))
  || conditions.bounds.width < 720 || conditions.bounds.height < 480 || !Number.isSafeInteger(conditions.viewport.width) || !Number.isSafeInteger(conditions.viewport.height)
  || conditions.viewport.width <= 0 || conditions.viewport.height <= 0 || !Number.isFinite(conditions.dpr) || conditions.dpr <= 0 || conditions.zoom !== 1)
  throw new Error('Invalid explicit native surface conditions; do not compensate with viewport emulation or zoom.');
if (!conditions.responsive && (conditions.bounds.width !== 1440 || conditions.bounds.height !== 1000 || conditions.viewport.width !== 1440 || conditions.viewport.height !== 1000 || conditions.dpr !== 2))
  throw new Error('Different geometry/scale must be an explicitly named, separate responsive case.');
await writeFile(join(output, 'surface-conditions.json'), JSON.stringify(conditions, null, 2));
const compiler = Bun.spawn(['/usr/bin/xcrun', 'swiftc', join(import.meta.dir, 'geometry.swift'), '-o', join(output, 'native-geometry')], {
  env: { HOME: output, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CLANG_MODULE_CACHE_PATH: join(output, 'swift-module-cache') },
  stdout: Bun.file(join(output, 'geometry-build.log')), stderr: Bun.file(join(output, 'geometry-build-errors.log')),
});
if (await compiler.exited !== 0) throw new Error('Native geometry inspector compilation failed before any App launch.');
const sources = [
  'apps/desktop/src/renderer/SessionFork.tsx', 'apps/desktop/src/renderer/session-fork-state.ts', 'apps/desktop/src/renderer/session-fork.css',
  'apps/desktop/src/renderer/App.tsx', 'apps/desktop/src/renderer/ComposerAutocomplete.tsx', 'apps/desktop/src/renderer/app-command-bindings.ts', 'apps/desktop/src/renderer/app-shortcuts.ts',
  'apps/desktop/src/main/main.ts', 'apps/desktop/src/main/preload.ts', 'apps/desktop/src/main/command-endpoints.ts',
  'packages/shared/src/session-fork.ts', 'packages/shared/src/protocol.ts', 'apps/host/src/session-fork.ts', 'apps/host/src/server.ts', 'apps/host/src/store.ts',
  'apps/host/src/omp/session-fork.ts', 'apps/host/src/omp/runtime.ts', 'apps/host/src/omp-workers/protocol.ts', 'apps/host/src/omp-workers/runtime.ts', 'apps/host/src/omp-workers/entry.ts',
  ...['host.ts', 'fixture.ts', 'main.cjs', 'run.ts', 'geometry.swift', 'surface-guard.cjs'].map(name => `scripts/acceptance/session-fork-app/${name}`),
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(join(repository, path))).digest('hex')])));
const before = await hashes(); await writeFile(join(output, 'source-before.json'), JSON.stringify(before, null, 2));
const fixture = await startForkFixture(output);
let electron: Bun.Subprocess | undefined;
try {
  const profile = join(fixture.root, 'profile'), candidate = join(output, 'candidate-app');
  await mkdir(profile, { recursive: true }); await mkdir(candidate);
  const state = new WindowStateStore(profile, 'primary');
  const result = state.saveView({ ...defaultWindowView(), route: { hostId: fixture.connection.hostId, sessionId: fixture.context.sourceId },
    expandedProjects: [`${fixture.connection.hostId}:${fixture.context.projectId}`], collapsedSidebarSections: [], workspaceOpen: false,
    dock: { tabs: [], state: { ...createDockState(), right: { tabIds: [], open: false } } } });
  if (result.error) throw new Error(result.error);
  await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'agent-desktop-fork-acceptance', version: '0.0.0', main: 'main.cjs' }));
  await copyFile(join(import.meta.dir, 'main.cjs'), join(candidate, 'main.cjs'));
  await copyFile(join(import.meta.dir, 'surface-guard.cjs'), join(candidate, 'surface-guard.cjs'));
  await symlink(join(repository, 'apps/desktop/dist'), join(candidate, 'dist'), 'dir');
  electron = Bun.spawn([process.execPath, join(repository, 'node_modules/electron/cli.js'), candidate, output, fixture.root, repository], {
    cwd: fixture.root, env: { ...fixture.environment, AGENT_DESKTOP_PROJECT_ROOT: repository, AGENT_DESKTOP_BUN: process.execPath },
    stdout: Bun.file(join(output, 'electron.log')), stderr: Bun.file(join(output, 'electron-errors.log')),
  });
  const timer = setTimeout(() => electron!.kill('SIGTERM'), 180_000), code = await electron.exited; clearTimeout(timer);
  if (code !== 0) throw new Error(`Actual Fork App scenario failed (${code}); inspect ${output}`);
  const resultFile = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  if (!resultFile.passed) throw new Error(`Fork App did not accept its scenario; inspect ${output}`);
} finally {
  if (electron?.exitCode === null) { electron.kill('SIGTERM'); await electron.exited; }
  await fixture.stop();
  const after = await hashes(); await writeFile(join(output, 'source-after.json'), JSON.stringify(after, null, 2));
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({ electronExit: electron?.exitCode, fixtureRemoved: true, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after) }));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source changed during Fork acceptance; this is not a frozen result.');
}
