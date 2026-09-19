import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createSymbolNavigationFixture } from "./symbol-navigation-fixture";
import { exerciseSymbolNavigationApp } from "./symbol-navigation-app";
import { createDockState, dockTabId, insertDockTab } from "../../apps/desktop/src/renderer/dock-state";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import { WindowStateStore } from "../../apps/desktop/src/main/window-state";
import { prepareFileEditorGeometry } from "./file-editor-commands-app/geometry";

export async function launchSymbolNavigationApp(output: string, options: {
  restorePullRequests?: boolean;
  additionalTabs?: Array<{ path: string; destination: "right" | "bottom" }>;
  hostReady?(context: { fixture: string; output: string }): Promise<() => Promise<void>>;
  prepare?(page: Parameters<typeof exerciseSymbolNavigationApp>[0], context: { pid: number; output: string; fixture: string; geometry: Awaited<ReturnType<typeof prepareFileEditorGeometry>> }): Promise<void>;
  exercise?: typeof exerciseSymbolNavigationApp;
} = {}) {
const repo = resolve(import.meta.dir, "../..");
output = resolve(output);
const restorePullRequests = options.restorePullRequests === true;
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
const puppeteer: { connect(options: { browserURL: string; protocolTimeout: number; defaultViewport: null }): Promise<OwnedBrowser> } = require("puppeteer-core");
const electronPath: unknown = createRequire(join(repo, "package.json"))("electron");
if (typeof electronPath !== "string" || !electronPath.startsWith(join(repo, "node_modules/"))) throw new Error("Expected the isolated checkout's Electron executable.");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "agent-symbol-app-")));
await createSymbolNavigationFixture(join(fixture, "project"));
await mkdir(join(fixture, "bin"));
await mkdir(join(fixture, "tmp"), { mode: 0o700 });
// The page transition needs no GitHub account or request. Refuse the actual
// host's gh calls through a controlled executable, without changing App routes.
await writeFile(join(fixture, "bin/gh"), "#!/bin/sh\necho 'No GitHub account in this isolated symbol fixture.' >&2\nexit 1\n", { mode: 0o700 });
await writeFile(join(fixture, "bin/tailscale"), "#!/bin/sh\nprintf '%s\\n' 'Tailscale refused by the isolated acceptance fixture.' >> \"$FILE_EDITOR_ACCEPTANCE_OUTPUT/tailscale-refusals.log\"\necho 'Tailscale refused by the isolated acceptance fixture.' >&2\nexit 1\n", { mode: 0o700 });
const username = userInfo().username;
const env = { HOME: fixture, USER: username, LOGNAME: username, PATH: `${join(fixture, "bin")}:${process.env.PATH ?? ""}`, TMPDIR: join(fixture, "tmp"),
  PI_CODING_AGENT_DIR: join(fixture, "agent"), XDG_DATA_HOME: join(fixture, "xdg-data"), XDG_STATE_HOME: join(fixture, "xdg-state"),
  XDG_CONFIG_HOME: join(fixture, "xdg-config"), XDG_CACHE_HOME: join(fixture, "xdg-cache"),
  AGENT_DESKTOP_DATA_DIR: join(fixture, "data"), AGENT_DESKTOP_PROFILE_DIR: join(fixture, "profile"),
  AGENT_DESKTOP_NATIVE_TERMINALS: "0", AGENT_DESKTOP_BUN: process.execPath, AGENT_DESKTOP_PROJECT_ROOT: repo, FILE_EDITOR_ACCEPTANCE_OUTPUT: output,
  PI_DISABLE_DOTENV: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", TERM: "dumb" };
const isolatedProject = await realpath(join(fixture, "project")), isolatedTmp = await realpath(env.TMPDIR);
if (![isolatedProject, isolatedTmp].every(path => path.startsWith(fixture + "/"))) throw new Error("Disposable project/TMPDIR escaped the canonical fake HOME.");
await writeFile(join(output, "disposable-isolation.json"), JSON.stringify({ home: fixture, project: isolatedProject, tmpdir: isolatedTmp, homeAncestor: true, policy: "No retained registry access is authorized." }, null, 2));
const host = Bun.spawn([process.execPath, join(import.meta.dir, "git-file-app-host.ts"), fixture], { cwd: fixture, env, ipc: () => {}, stdout: Bun.file(join(output, "host.log")), stderr: Bun.file(join(output, "host-errors.log")) });
let electron: Bun.Subprocess | undefined;
type OwnedBrowser = ReturnType<Parameters<typeof exerciseSymbolNavigationApp>[0]["browser"]>;
let browser: OwnedBrowser | undefined;
let passed = false;
let closeTransport: (() => Promise<void>) | undefined;
try {
  const deadline = Date.now() + 40_000;
  while (!await Bun.file(join(fixture, "ready.json")).exists()) {
    if (host.exitCode !== null || Date.now() > deadline) throw new Error("The isolated host did not start.");
    await Bun.sleep(50);
  }
  const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8")) as { connection: { hostId: string }; target: { projectId: string } };
  closeTransport = await options.hostReady?.({ fixture, output });
  const descriptor = { kind: "file" as const, hostId: ready.connection.hostId, target: `project:${ready.target.projectId}` as const, title: "symbol-source.ts", filePath: "symbol-source.ts", fileMode: "source" as const };
  const tab = { ...descriptor, id: dockTabId(descriptor) };
  const tabs = [tab];
  let dock = createDockState();
  for (const extra of options.additionalTabs ?? []) {
    const descriptor = { ...tab, title: extra.path, filePath: extra.path }, next = { ...descriptor, id: dockTabId(descriptor) };
    tabs.push(next); dock = insertDockTab(dock, next, extra.destination);
  }
  dock = insertDockTab(dock, tab, "right");
  const saved = new WindowStateStore(env.AGENT_DESKTOP_PROFILE_DIR, "primary").saveView({ ...defaultWindowView(), route: { hostId: ready.connection.hostId, sessionId: null }, dock: { state: dock, tabs } });
  if (saved.error) throw new Error(saved.error);
  const openApp = async (name: string) => {
    const deadline = Date.now() + 40_000, errors = join(output, `${name}-errors.log`);
    electron = Bun.spawn([electronPath, join(import.meta.dir, "file-editor-commands-app/electron.cjs"), repo], { cwd: repo, env, stdout: Bun.file(join(output, `${name}.log`)), stderr: Bun.file(errors) });
    let port: string | undefined;
    while (!port) {
      port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(await readFile(errors, "utf8"))?.[1];
      if (electron.exitCode !== null || Date.now() > deadline) throw new Error("The owned Electron debugger did not start.");
      if (!port) await Bun.sleep(50);
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 10_000, defaultViewport: null });
    let page = (await browser.pages()).find(page => page.url().startsWith("file:"));
    while (!page) {
      if (Date.now() > deadline) throw new Error("The production App page did not open.");
      await Bun.sleep(50); page = (await browser.pages()).find(page => page.url().startsWith("file:"));
    }
    await page.waitForFunction(() => Boolean(window.agentDesktop?.getHosts));
    let discovery = await page.evaluate(() => window.agentDesktop.getHosts());
    while (discovery.status === "connecting" && Date.now() < deadline) {
      await Bun.sleep(50); discovery = await page.evaluate(() => window.agentDesktop.getHosts());
    }
    await writeFile(join(output, `${name}-discovery.json`), JSON.stringify(discovery, null, 2));
    if (discovery.status !== "unavailable" || discovery.hosts.length !== 0) throw new Error("Production discovery did not refuse Tailscale with zero remote peers; UI input is prohibited.");
    const context = { pid: electron.pid, executable: await realpath(electronPath), output, fixture }, geometry = await prepareFileEditorGeometry(page, context);
    await options.prepare?.(page, { ...context, geometry });
    return page;
  };
  let page = await openApp("electron");
  if (restorePullRequests) {
    const open = await page.waitForSelector('.nav-action[aria-label="Pull requests"]', { visible: true });
    if (!open) throw new Error("The production Pull requests action did not mount.");
    await open.click();
    await page.waitForSelector('button[aria-label="Close pull requests"]', { visible: true });
    const saveDeadline = Date.now() + 5_000;
    while (!new WindowStateStore(env.AGENT_DESKTOP_PROFILE_DIR, "primary").bootstrap().state?.pullRequestsOpen) {
      if (Date.now() > saveDeadline) throw new Error("The actual App did not persist the open Pull requests page.");
      await Bun.sleep(50);
    }
    await page.screenshot({ path: join(output, "before-restart-pull-requests.png") });
    await writeFile(join(output, "before-restart-window.json"), JSON.stringify(new WindowStateStore(env.AGENT_DESKTOP_PROFILE_DIR, "primary").bootstrap(), null, 2));
    const first = electron!;
    await browser!.close(); browser = undefined;
    if (await first.exited !== 0 || host.exitCode !== null) throw new Error("The first App process did not close cleanly with its host retained.");
    await writeFile(join(output, "restart.json"), JSON.stringify({ firstAppPid: first.pid, firstAppExit: first.exitCode, hostPid: host.pid, hostRetained: true }));
    electron = undefined;
    page = await openApp("restored-electron");
    if (electron!.pid === first.pid) throw new Error("The restored App must be a fresh process.");
  }
  await (options.exercise ?? exerciseSymbolNavigationApp)(page, join(output, "app"), { restoredPullRequests: restorePullRequests });
  passed = true;
} finally {
  let browserCloseError: string | undefined, transportCloseError: string | undefined;
  try { if (browser) await browser.close(); } catch (error) { browserCloseError = String(error); }
  if (electron?.exitCode === null) { electron.kill("SIGTERM"); await electron.exited; }
  try { await closeTransport?.(); } catch (error) { transportCloseError = String(error); }
  if (host.exitCode === null) host.send({ stop: true });
  const timer = setTimeout(() => host.kill("SIGKILL"), 15_000), hostExit = await host.exited; clearTimeout(timer);
  const after = await hashes(), sourceStable = JSON.stringify(before) === JSON.stringify(after);
  await writeFile(join(output, "source-after.json"), JSON.stringify(after, null, 2));
  await writeFile(join(output, "cleanup.json"), JSON.stringify({ passed, sourceStable, controllerPid: process.pid, hostPid: host.pid, hostExit, spawnedElectronPid: electron?.pid, electronExit: electron?.exitCode, browserCloseError, transportCloseError, fixture, scope: "Production App/main/preload, real isolated host/compiler/Pierre; controlled unavailable gh/Tailscale and no-provider worker. Discovery receipt and geometry logs bound this run; no account or provider use." }, null, 2));
  if (passed && hostExit === 0 && !browserCloseError && !transportCloseError) await rm(fixture, { recursive: true, force: true });
  if (!sourceStable || hostExit !== 0 || browserCloseError || transportCloseError) throw new Error("Source changed or owned cleanup failed; evidence retained.");
}
}

if (import.meta.main) await launchSymbolNavigationApp(process.argv[2] ?? `.data/symbol-app-${Date.now()}`, { restorePullRequests: process.argv.includes("--restore-pull-requests") });
