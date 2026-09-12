import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGitFileAppCases, createGitFileFixture } from "./git-file-fixture";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import { WindowStateStore } from "../../apps/desktop/src/main/window-state";

const repo = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/git-blame-flow/app-${Date.now()}`);
if (!await Bun.file(join(repo, "apps/desktop/dist/main.cjs")).exists()) throw new Error("Main must build the integrated production desktop before this acceptance entry runs: bun run build");
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Acceptance output must be a new empty private directory.");
const fixture = await createGitFileFixture(), cases = await createGitFileAppCases(fixture), before = await fixture.snapshot();
await writeFile(join(output, "fixture.json"), JSON.stringify({ root: fixture.root, scope: "Owned disposable Git/native fixture; connection files remain private." }), { mode: 0o600 });
const sourceFiles = ["scripts/acceptance/git-file-app.ts", "scripts/acceptance/git-file-app-electron.cjs", "apps/desktop/src/renderer/app-command-bindings.ts", "packages/shared/src/git-file-history.ts", "packages/shared/src/workspace-protocol.ts", "apps/host/src/workspace/git-file-history.ts", "apps/host/src/workspace/service.ts", "apps/host/src/workspace-http.ts", "apps/desktop/src/renderer/git-file-history-state.ts", "apps/desktop/src/renderer/WorkspaceGitFilePanel.tsx", "apps/desktop/src/renderer/PierreGitBlame.tsx", "apps/desktop/src/renderer/WorkspacePanel.tsx", "apps/desktop/src/renderer/PierreSourceEditor.tsx", "apps/desktop/src/renderer/workspace-git-file.css", "apps/desktop/src/renderer/App.tsx", "apps/desktop/dist/main.cjs"];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash("sha256").update(await readFile(join(repo, path))).digest("hex")])));
const sourceBefore = await hashes();
const isolated = { HOME: fixture.root, PATH: process.env.PATH!, TMPDIR: fixture.root, PI_CODING_AGENT_DIR: join(fixture.root, "agent"),
  XDG_DATA_HOME: join(fixture.root, "xdg-data"), XDG_STATE_HOME: join(fixture.root, "xdg-state"), XDG_CONFIG_HOME: join(fixture.root, "xdg-config"), XDG_CACHE_HOME: join(fixture.root, "xdg-cache"),
  AGENT_DESKTOP_DATA_DIR: join(fixture.root, "data"), AGENT_DESKTOP_PROFILE_DIR: join(fixture.root, "profile"), AGENT_DESKTOP_NATIVE_TERMINALS: "0", AGENT_DESKTOP_BUN: process.execPath,
  AGENT_DESKTOP_PROJECT_ROOT: repo, PI_DISABLE_DOTENV: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", TERM: "dumb" };
const host = Bun.spawn([process.execPath, join(import.meta.dir, "git-file-app-host.ts"), fixture.root], { cwd: fixture.root, env: isolated, ipc: () => {}, stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")) });
let electron: { exitCode: number | null; exited: Promise<number>; kill(signal?: number | NodeJS.Signals): void } | undefined;
let passed = false;
try {
  for (let index = 0; !await Bun.file(join(fixture.root, "ready.json")).exists(); index++) {
    if (index > 700 || host.exitCode !== null) throw new Error("Isolated native host failed to become ready.");
    await Bun.sleep(50);
  }
  const ready: unknown = JSON.parse(await readFile(join(fixture.root, "ready.json"), "utf8"));
  if (!ready || typeof ready !== "object" || !("connection" in ready) || !ready.connection || typeof ready.connection !== "object" || !("hostId" in ready.connection) || typeof ready.connection.hostId !== "string"
    || !("target" in ready) || !ready.target || typeof ready.target !== "object" || !("projectId" in ready.target) || typeof ready.target.projectId !== "string") throw new Error("Invalid fixture host identity.");
  const descriptor = { kind: "file" as const, hostId: ready.connection.hostId, target: `project:${ready.target.projectId}` as const, title: "renamed.ts", filePath: "src/renamed.ts", fileMode: "source" as const };
  const tab: DockTab = { ...descriptor, id: dockTabId(descriptor) };
  const dock = insertDockTab(createDockState(), tab, "right");
  const saved = new WindowStateStore(isolated.AGENT_DESKTOP_PROFILE_DIR, "primary").saveView({ ...defaultWindowView(), route: { hostId: ready.connection.hostId, sessionId: null }, dock: { state: dock, tabs: [tab] } });
  if (saved.error) throw new Error(saved.error);
  await writeFile(join(output, "launch.json"), JSON.stringify({ first: fixture.first, cwd: fixture.cwd, cases }), { mode: 0o600 });
  electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "git-file-app-electron.cjs"), output, repo], { cwd: repo, env: isolated,
    stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => electron?.kill("SIGTERM"), 120000);
  const code = await electron.exited; clearTimeout(timer);
  const after = await fixture.snapshot(), sourceAfter = await hashes();
  const gitUnchanged = ["head", "index", "config", "reflog", "refs"].every(key => before[key as keyof typeof before] === after[key as keyof typeof after]);
  const evidence = { exitCode: code, gitUnchanged, sourceBefore, sourceAfter, sourceStable: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
    before, after, fixtureCommits: { first: fixture.first, edited: fixture.edited, renamed: fixture.renamed, head: fixture.head } };
  await writeFile(join(output, "host-evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  if (code !== 0 || !gitUnchanged || !evidence.sourceStable) throw new Error(`Actual App Git file acceptance failed. Inspect ${output}`);
  passed = true;
  console.log(JSON.stringify({ passed: true, output, scope: "actual production App/editor and isolated native host/Git" }));
} finally {
  if (electron && electron.exitCode === null) { electron.kill("SIGTERM"); await electron.exited; }
  if (host.exitCode === null) host.send({ stop: true });
  await host.exited;
  if (passed) {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(join(output, "launch.json"), { force: true });
  } else {
    await writeFile(join(output, "retained-fixture.json"), JSON.stringify({ root: fixture.root, reason: "Failed acceptance state retained for diagnosis; connection files remain private." }), { mode: 0o600 });
  }
}
