import { access, copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startForceFixture } from './fixture';
import { WindowStateStore } from '../../../apps/desktop/src/main/window-state';
import { defaultWindowView } from '../../../apps/desktop/src/window-state';
import { createDockState } from '../../../apps/desktop/src/renderer/dock-state';

interface SurfaceConditions {
  name: string; responsive: boolean; bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number }; dpr: number; zoom: 1;
}
const repository = resolve(import.meta.dir, '../../..'), output = resolve(process.argv[2] ?? '.data/force-tool-app-acceptance');
// Main supplies the coordinated build and owns the native-input lease. This
// runner never rebuilds the project or changes an installed/personal profile.
await access(join(repository, 'apps/desktop/dist/main.cjs'));
await access(join(repository, 'apps/desktop/dist/preload.cjs'));
await access(join(repository, 'apps/desktop/dist/renderer/index.html'));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Refusing to overwrite prior Force acceptance evidence.');
if (process.platform !== 'darwin') throw new Error('This Force native surface fixture requires macOS CG/AX inspection.');
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
const compiler = Bun.spawn(['/usr/bin/xcrun', 'swiftc', join(import.meta.dir, '../session-fork-app/geometry.swift'), '-o', join(output, 'native-geometry')], {
  env: { HOME: output, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CLANG_MODULE_CACHE_PATH: join(output, 'swift-module-cache') },
  stdout: Bun.file(join(output, 'geometry-build.log')), stderr: Bun.file(join(output, 'geometry-build-errors.log')),
});
if (await compiler.exited !== 0) throw new Error('Native geometry inspector compilation failed before any App launch.');
const fixedSources = [
  'apps/desktop/dist/main.cjs', 'apps/desktop/dist/preload.cjs', 'apps/desktop/dist/renderer/index.html',
  'apps/desktop/src/renderer/App.tsx', 'apps/desktop/src/renderer/submissions.ts',
  'apps/desktop/src/renderer/ForceToolControl.tsx', 'apps/desktop/src/renderer/force-tool-state.ts',
  'apps/desktop/src/renderer/use-force-tool.ts', 'apps/desktop/src/main/main.ts',
  'apps/desktop/src/main/preload.ts', 'apps/desktop/src/main/force-tool-transport.ts',
  'apps/desktop/src/main/command-endpoints.ts', 'packages/shared/src/protocol.ts',
  'packages/shared/src/force-tool.ts', 'apps/host/src/server.ts', 'apps/host/src/session-force-tool-http.ts',
  'apps/host/src/force-tool-recovery.ts', 'apps/host/src/omp/runtime.ts', 'apps/host/src/omp/commands.ts',
  'apps/host/src/omp/force-tool.ts', 'apps/host/src/omp/force-tool-capability.ts', 'apps/host/src/omp/force-tool-admission.ts',
  'apps/host/src/omp/force-tool-recovery-outcome.ts', 'apps/host/src/omp-workers/entry.ts',
  'apps/host/src/omp-workers/runtime.ts', 'apps/host/src/omp-workers/protocol.ts', 'package.json', 'bun.lock',
  ...['host.ts', 'fixture.ts', 'main.cjs', 'run.ts', 'worker.ts', 'provider.ts', 'extension.ts', 'README.md'].map(name => `scripts/acceptance/force-tool-app/${name}`),
  'scripts/acceptance/session-fork-app/geometry.swift', 'scripts/acceptance/session-fork-app/surface-guard.cjs',
];
// Re-inventory maintained sources at BOTH boundaries, so added/deleted files
// also change the fence. Only regular files are included; nested symlinks and
// node_modules directories are skipped. Explicit installed package roots below
// retain the existing native-package input fence, not an import-closure claim.
const sourcePaths = async (): Promise<string[]> => {
  const sources = new Set(fixedSources);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(repository, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) sources.add(path);
    }
  };
  for (const directory of [
    'apps/host/src', 'packages/shared/src', 'apps/desktop/src', 'patches',
    'node_modules/@oh-my-pi/pi-coding-agent', 'node_modules/@oh-my-pi/pi-agent-core',
    'node_modules/@oh-my-pi/pi-ai', 'apps/desktop/dist/renderer',
  ]) await walk(directory);
  return [...sources].sort();
};
const hashes = async () => Object.fromEntries(await Promise.all((await sourcePaths()).map(async path =>
  [path, createHash('sha256').update(await readFile(join(repository, path))).digest('hex')])));
const before = await hashes(); await writeFile(join(output, 'source-before.json'), JSON.stringify(before, null, 2));
const fixture = await startForceFixture(output);
let electron: Bun.Subprocess | undefined;
try {
  const profile = join(fixture.root, 'profile'), candidate = join(output, 'candidate-app');
  await mkdir(profile, { recursive: true }); await mkdir(candidate);
  const state = new WindowStateStore(profile, 'primary');
  const result = state.saveView({ ...defaultWindowView(), route: { hostId: fixture.connection.hostId, sessionId: fixture.context.sourceId },
    expandedProjects: [`${fixture.connection.hostId}:${fixture.context.projectId}`], collapsedSidebarSections: [], workspaceOpen: false,
    dock: { tabs: [], state: { ...createDockState(), right: { tabIds: [], open: false } } } });
  if (result.error) throw new Error(result.error);
  await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'agent-desktop-force-tool-acceptance', version: '0.0.0', main: 'main.cjs' }));
  await copyFile(join(import.meta.dir, 'main.cjs'), join(candidate, 'main.cjs'));
  await copyFile(join(import.meta.dir, '../session-fork-app/surface-guard.cjs'), join(candidate, 'surface-guard.cjs'));
  await symlink(join(repository, 'apps/desktop/dist'), join(candidate, 'dist'), 'dir');
  electron = Bun.spawn([process.execPath, join(repository, 'node_modules/electron/cli.js'), candidate, output, fixture.root, repository], {
    cwd: fixture.root, env: { ...fixture.environment, AGENT_DESKTOP_PROJECT_ROOT: repository, AGENT_DESKTOP_BUN: process.execPath },
    stdout: Bun.file(join(output, 'electron.log')), stderr: Bun.file(join(output, 'electron-errors.log')),
  });
  const timer = setTimeout(() => electron!.kill('SIGTERM'), 420_000), code = await electron.exited; clearTimeout(timer);
  if (code !== 0) throw new Error(`Actual Force App scenario failed (${code}); inspect ${output}`);
  const resultFile = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  if (!resultFile.passed) throw new Error(`Force App did not accept its scenario; inspect ${output}`);
} finally {
  if (electron?.exitCode === null) { electron.kill('SIGTERM'); await electron.exited; }
  await fixture.stop();
  const after = await hashes(); await writeFile(join(output, 'source-after.json'), JSON.stringify(after, null, 2));
  await writeFile(join(output, 'cleanup.json'), JSON.stringify({ electronExit: electron?.exitCode, fixtureRemoved: true, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after) }));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source changed during Force acceptance; this is not a frozen result.');
}
