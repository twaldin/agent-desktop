import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createSymbolNavigationFixture } from "./symbol-navigation-fixture";
import { exerciseSymbolNavigationApp } from "./symbol-navigation-app";
import { createDockState, dockTabId, insertDockTab } from "../../apps/desktop/src/renderer/dock-state";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import { WindowStateStore } from "../../apps/desktop/src/main/window-state";

const repo = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/symbol-app-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Acceptance output must be a new empty private directory.");
if (!await Bun.file(join(repo, "apps/desktop/dist/main.cjs")).exists()) throw new Error("Build the current production desktop before running symbol acceptance.");
const tracked = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repo });
if (tracked.exitCode) throw new Error("Could not record the source inventory.");
const paths = [...new Set(tracked.stdout.toString().split("\0").filter(Boolean))].sort();
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash("sha256").update(await readFile(join(repo, path))).digest("hex")])));
const before = await hashes();
await writeFile(join(output, "source-before.json"), JSON.stringify(before, null, 2));
const require = createRequire(await realpath(join(repo, "node_modules/@oh-my-pi/pi-coding-agent/package.json")));
const puppeteer: { connect(options: { browserURL: string; protocolTimeout: number }): Promise<OwnedBrowser> } = require("puppeteer-core");
const electronPath: unknown = createRequire(join(repo, "package.json"))("electron");
if (typeof electronPath !== "string" || !electronPath.startsWith(join(repo, "node_modules/"))) throw new Error("Expected the isolated checkout's Electron executable.");
const fixture = await mkdtemp(join(tmpdir(), "agent-symbol-app-"));
await createSymbolNavigationFixture(join(fixture, "project"));
await mkdir(join(fixture, "bin"));
// The page transition needs no GitHub account or request. Refuse the actual
// host's gh calls through a controlled executable, without changing App routes.
await writeFile(join(fixture, "bin/gh"), "#!/bin/sh\necho 'No GitHub account in this isolated symbol fixture.' >&2\nexit 1\n", { mode: 0o700 });
const env = { HOME: fixture, PATH: `${join(fixture, "bin")}:${process.env.PATH ?? ""}`, TMPDIR: fixture,
  PI_CODING_AGENT_DIR: join(fixture, "agent"), XDG_DATA_HOME: join(fixture, "xdg-data"), XDG_STATE_HOME: join(fixture, "xdg-state"),
  XDG_CONFIG_HOME: join(fixture, "xdg-config"), XDG_CACHE_HOME: join(fixture, "xdg-cache"),
  AGENT_DESKTOP_DATA_DIR: join(fixture, "data"), AGENT_DESKTOP_PROFILE_DIR: join(fixture, "profile"),
  AGENT_DESKTOP_NATIVE_TERMINALS: "0", AGENT_DESKTOP_BUN: process.execPath, AGENT_DESKTOP_PROJECT_ROOT: repo,
  PI_DISABLE_DOTENV: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", TERM: "dumb" };
const host = Bun.spawn([process.execPath, join(import.meta.dir, "git-file-app-host.ts"), fixture], { cwd: fixture, env, ipc: () => {}, stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")) });
let electron: Bun.Subprocess | undefined;
type OwnedBrowser = ReturnType<Parameters<typeof exerciseSymbolNavigationApp>[0]["browser"]>;
let browser: OwnedBrowser | undefined;
let passed = false;
try {
  const deadline = Date.now() + 40_000;
  while (!await Bun.file(join(fixture, "ready.json")).exists()) {
    if (host.exitCode !== null || Date.now() > deadline) throw new Error("The isolated host did not start.");
    await Bun.sleep(50);
  }
  const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8")) as { connection: { hostId: string }; target: { projectId: string } };
  const descriptor = { kind: "file" as const, hostId: ready.connection.hostId, target: `project:${ready.target.projectId}` as const, title: "symbol-source.ts", filePath: "symbol-source.ts", fileMode: "source" as const };
  const tab = { ...descriptor, id: dockTabId(descriptor) };
  const saved = new WindowStateStore(env.AGENT_DESKTOP_PROFILE_DIR, "primary").saveView({ ...defaultWindowView(), route: { hostId: ready.connection.hostId, sessionId: null }, dock: { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] } });
  if (saved.error) throw new Error(saved.error);
  electron = Bun.spawn([electronPath, join(import.meta.dir, "symbol-navigation-electron.cjs"), repo], { cwd: repo, env, stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  let port: string | undefined;
  while (!port) {
    port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(await readFile(join(output, "electron-errors.log"), "utf8"))?.[1];
    if (electron.exitCode !== null || Date.now() > deadline) throw new Error("The owned Electron debugger did not start.");
    if (!port) await Bun.sleep(50);
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 10_000 });
  let page = (await browser.pages()).find(page => page.url().startsWith("file:"));
  while (!page) {
    if (Date.now() > deadline) throw new Error("The production App page did not open.");
    await Bun.sleep(50); page = (await browser.pages()).find(page => page.url().startsWith("file:"));
  }
  await exerciseSymbolNavigationApp(page, join(output, "app"));
  passed = true;
} finally {
  let browserCloseError: string | undefined;
  try { if (browser) await browser.close(); } catch (error) { browserCloseError = String(error); }
  if (electron?.exitCode === null) { electron.kill("SIGTERM"); await electron.exited; }
  if (host.exitCode === null) host.send({ stop: true });
  const timer = setTimeout(() => host.kill("SIGKILL"), 15_000), hostExit = await host.exited; clearTimeout(timer);
  const after = await hashes(), sourceStable = JSON.stringify(before) === JSON.stringify(after);
  await writeFile(join(output, "source-after.json"), JSON.stringify(after, null, 2));
  await writeFile(join(output, "cleanup.json"), JSON.stringify({ passed, sourceStable, hostExit, electronExit: electron?.exitCode, browserCloseError, fixture, scope: "Production App/main/preload, real isolated host/compiler/Pierre; controlled unavailable gh and no-provider worker. No account or provider use." }, null, 2));
  if (passed && hostExit === 0) await rm(fixture, { recursive: true, force: true });
  if (!sourceStable || hostExit !== 0 || browserCloseError) throw new Error("Source changed or owned cleanup failed; evidence retained.");
}
