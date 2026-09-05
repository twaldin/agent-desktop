import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Standalone real-browser experiment; deliberately outside the full test suite.
// No model request, production native patch, installed app or existing profile.
const childMode = process.argv[2] === "--child";
const sourceRoot = resolve(import.meta.dir, "../..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function existingTestingBrowser(explicit?: string): Promise<string> {
  if (explicit) { assert((await stat(explicit)).isFile(), "Browser binary must be a file"); return resolve(explicit); }
  const candidates: string[] = [];
  for (const directory of [join(homedir(), ".omp/puppeteer/chrome"), join(homedir(), ".cache/puppeteer/chrome")]) {
    const versions = await readdir(directory).catch(() => []);
    for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const executable = join(directory, version, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (await stat(executable).then(info => info.isFile(), () => false)) candidates.push(executable);
    }
  }
  assert(candidates[0], "No existing Chrome for Testing binary found. Supply its absolute path; this experiment never downloads a browser.");
  return candidates[0];
}

async function parent() {
  const output = resolve(process.argv[2] ?? `.data/native-browser-acceptance/${new Date().toISOString().replaceAll(":", "-")}`);
  const executable = await existingTestingBrowser(process.argv[3]);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const nativeRoot = join(sourceRoot, "node_modules/@oh-my-pi/pi-coding-agent");
  assert.equal((await Bun.file(join(nativeRoot, "package.json")).json()).version, "18.1.10", "This proof is pinned to OMP18.1.10");
  const nativeSourceHashes = {
    "src/tools/browser.ts": "bcfaad44c5d0fdf2cba89a22e0d01ae5799556394c5ffc65db433d3e4515c7f1",
    "src/tools/browser/registry.ts": "b55fe741a5887199d4b43c358fb10ebd82c0f050add1caa4db69e73d313c376b",
    "src/tools/browser/tab-supervisor.ts": "9215d5bed2a0f1069216db5d4691a2e72b1bd599914d46854c7cfaba7f1c3f9e",
    "src/tools/browser/tab-worker.ts": "5e1fd0c13ebf6012b09a0ef65519574b8bf6c1f3e0a7351e39d433561207f9e6",
  };
  const verifyNativeSources = async () => {
    for (const [file, expected] of Object.entries(nativeSourceHashes)) assert.equal(sha256(await readFile(join(nativeRoot, file))), expected, `Pinned native source changed: ${file}`);
  };
  await verifyNativeSources();
  const isolated = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-native-browser-")));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", SHELL: "/bin/sh",
    HOME: join(isolated, "home"), TMPDIR: join(isolated, "tmp"),
    XDG_CONFIG_HOME: join(isolated, "config"), XDG_CACHE_HOME: join(isolated, "cache"),
    XDG_DATA_HOME: join(isolated, "data"), XDG_STATE_HOME: join(isolated, "state"),
    PUPPETEER_EXECUTABLE_PATH: executable, PI_BROWSER_CMUX: "0", PI_BROWSER_RELAY: "0",
  };
  await Promise.all(["home", "tmp", "config", "cache", "data", "state", "project", "agent"].map(name => mkdir(join(isolated, name))));
  const provenance = { scriptSha256: sha256(await readFile(import.meta.path)), browserExecutable: executable,
    browserExecutableSha256: sha256(await readFile(executable)), bunVersion: Bun.version,
    nativeSourceHashes, sourceRoot, isolated, output, startedAt: new Date().toISOString() };
  await writeFile(join(output, "invocation.json"), JSON.stringify(provenance, null, 2) + "\n");
  console.log(JSON.stringify({ stage: "starting", output, isolated, executable }));
  try {
    const child = Bun.spawn([process.execPath, import.meta.path, "--child", isolated, output], {
      cwd: join(isolated, "project"), env, stdin: "ignore", stdout: Bun.file(join(output, "child.stdout.log")), stderr: Bun.file(join(output, "child.stderr.log")),
    });
    await writeFile(join(output, "child.json"), JSON.stringify({ pid: child.pid }) + "\n");
    const code = await child.exited;
    assert.equal(code, 0, `Native browser proof failed; inspect ${output}/result.json and child.stderr.log`);
    const result = await Bun.file(join(output, "result.json")).json();
    assert.equal(result.passed, true);
    assert.equal(sha256(await readFile(import.meta.path)), provenance.scriptSha256, "Experiment source changed during run");
    await verifyNativeSources();
    await rm(isolated, { recursive: true, force: true });
    result.isolatedProfileTreeRemoved = true;
    result.runnerExitCode = code;
    result.sourceHashesStable = true;
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ passed: true, checks: result.checks.length, result: join(output, "result.json") }));
  } catch (error) {
    // Retain only this disposable tree on failure for diagnosis and precise cleanup.
    console.error(`Isolated browser proof failed; retained ${isolated}`);
    throw error;
  }
}

async function child() {
  const isolated = process.argv[3]!, output = process.argv[4]!;
  const cwd = join(isolated, "project"), agentDir = join(isolated, "agent");
  const checkpoints: Array<{ name: string; at: string; detail?: unknown }> = [];
  const record = async (name: string, detail?: unknown) => {
    checkpoints.push({ name, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail: structuredClone(detail) }) });
    await writeFile(join(output, "progress.json"), JSON.stringify(checkpoints, null, 2) + "\n");
  };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "External fetch/provider/download forbidden in this experiment");
    return nativeFetch(input, init);
  }, { preconnect: () => {} }) as typeof fetch;
  await writeFile(join(agentDir, "config.yml"), "browser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n");
  const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
  const { getTabsMapForTest, releaseAllTabs } = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");
  const { loadPuppeteer } = await import("@oh-my-pi/pi-coding-agent/tools/browser/launch");
  const { workerHostEntry } = await import("@oh-my-pi/pi-utils");
  const puppeteer = await loadPuppeteer();
  type Browser = Awaited<ReturnType<typeof puppeteer.connect>>;
  type Page = Awaited<ReturnType<Browser["newPage"]>>;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let observer: Browser | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let ownedBrowser: Browser | undefined;
  let ownedProfile: string | undefined;
  const auth = await discoverAuthStorage(agentDir);
  let failure: unknown;
  let nativeDisposed = false;
  const evidence: Record<string, unknown> = {};
  try {
    assert.equal(workerHostEntry(), null, "This must exercise actual SDK embedding, not the CLI broker path");
    const html = `<!doctype html><meta charset="utf-8"><title>Isolated native OMP browser proof</title>
      <style>html{background:#152535;color:#fff;font:24px sans-serif}body{margin:32px}button{font:24px sans-serif;padding:16px;background:#286ccc;color:#fff;border:0}input{font:24px sans-serif;caret-color:transparent}#count{font-size:48px}*{animation:none!important;transition:none!important}</style>
      <h1>One native browser target</h1><div id="count">0</div><button id="increment">Increment</button><p><input id="draft" value="unsent owner draft"></p>
      <script>const identity=crypto.randomUUID();let count=0;document.cookie='nativeProof='+identity+'; SameSite=Strict';
      document.querySelector('#increment').onclick=()=>{count++;document.querySelector('#count').textContent=String(count)};
      window.fixtureSnapshot=()=>({identity,count,draft:document.querySelector('#draft').value,cookie:document.cookie,url:location.href});</script>`;
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/proof"
      ? new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" } })
      : new Response("Not found", { status: 404 }) });
    const url = `http://127.0.0.1:${server.port}/proof`;
    const settings = await Settings.loadReadOnly({ cwd, agentDir });
    const manager = SessionManager.create(cwd, join(agentDir, "sessions"));
    await manager.ensureOnDisk();
    const result = await createAgentSession({ cwd, agentDir, settings, authStorage: auth,
      modelRegistry: new ModelRegistry(auth, join(agentDir, "models.yml"), { settings }),
      sessionManager: manager, agentRegistry: new AgentRegistry(), toolNames: ["eval"],
      disableExtensionDiscovery: true, enableMCP: false, hasUI: false });
    session = result.session;
    const tool = session.getToolByName("eval");
    assert(tool, "Real native Eval tool is required");
    const native = async (title: string, code: string) => {
      const result = await tool.execute(crypto.randomUUID(), { language: "js", title, code, timeout: 30 });
      await writeFile(join(output, `${title}.json`), JSON.stringify(result, null, 2) + "\n");
      assert(!result.isError, `Native Eval ${title} failed: ${JSON.stringify(result)}`);
      const details = result.details as { isError?: boolean; exitCode?: number; cells?: Array<{ status: string; exitCode?: number }> } | undefined;
      assert(!details?.isError && (!details?.exitCode || details.exitCode === 0), `Native Eval ${title} returned failure`);
      assert.equal(details?.cells?.length, 1, "Expected one actual native Eval cell");
      assert.equal(details?.cells?.[0]?.status, "complete", `Native Eval ${title} did not complete`);
      assert.equal(details?.cells?.[0]?.exitCode, 0, `Native Eval ${title} failed inside the language worker`);
      return result;
    };
    const name = "same-target-proof";
    await native("native-open", `await browser.open({name:${JSON.stringify(name)},url:${JSON.stringify(url)},viewport:{width:800,height:600,scale:1},timeout:30}); console.log("NATIVE_OPEN_OK");`);
    // Explicitly test-only enumeration, not the proposed production lifecycle API.
    const tab = getTabsMapForTest().get(name);
    assert(tab?.backend === "worker", "Expected native Puppeteer tab worker");
    assert.equal(tab.ownerSessionId, manager.getSessionId());
    assert.equal(tab.kindTag, "headless");
    ownedBrowser = tab.browser.browser;
    ownedProfile = tab.browser.userDataDir;
    assert(ownedProfile, "SDK path must own an isolated temporary Chrome profile");
    assert(ownedProfile.startsWith(join(isolated, "tmp")), "Browser profile escaped temporary fixture tree");
    const endpoint = ownedBrowser.wsEndpoint(), targetId = tab.targetId;
    const processHandle = ownedBrowser.process();
    assert(processHandle?.pid, "Expected a separately launched native Chromium process");
    const nativePid = processHandle.pid;
    await record("native-opened", { sessionId: manager.getSessionId(), targetId, nativePid, profile: ownedProfile, workerMode: tab.worker.mode });
    const attach = async () => {
      const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
      const root = await browser.target().createCDPSession();
      const { targetInfos } = await root.send("Target.getTargets");
      assert(targetInfos.some(info => info.targetId === targetId && info.url === url), "Observer did not discover exact native target");
      await root.detach();
      for (const candidate of browser.targets()) {
        if (candidate.type() !== "page") continue;
        const cdp = await candidate.createCDPSession();
        const info = await cdp.send("Target.getTargetInfo"); await cdp.detach();
        if (info.targetInfo.targetId === targetId) {
          const page = await candidate.page(); assert(page); return { browser, page };
        }
      }
      browser.disconnect(); throw new Error("Exact target had no observable Page");
    };
    let joined = await attach(); observer = joined.browser;
    const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { fixtureSnapshot(): { identity: string; count: number; draft: string; cookie: string; url: string } }).fixtureSnapshot());
    const initial = await snapshot(joined.page);
    assert.equal(initial.count, 0); assert.equal(initial.url, url); assert(initial.cookie.includes(initial.identity));
    evidence.browserVersion = await observer.version();
    evidence.sessionId = manager.getSessionId(); evidence.targetId = targetId; evidence.nativePid = nativePid;
    evidence.nativeSessionFile = manager.getSessionFile(); evidence.nativeApprovalMode = settings.get("tools.approvalMode");
    evidence.initial = initial; evidence.viewport = tab.info.viewport;
    await record("observer-same-target-state", initial);

    const imagePairs: Array<{ count: number; nativeSha256: string; observerSha256: string; bytes: number }> = [];
    const images = async (count: number) => {
      const dest = join(output, `native-count-${count}.png`);
      await native(`native-screenshot-${count}`, `await browser.tab(${JSON.stringify(name)}).run(async ({page})=>{await page.screenshot({path:${JSON.stringify(dest)},type:"png"});}); console.log("NATIVE_SCREENSHOT_OK");`);
      const nativeBytes = await readFile(dest), observerBytes = await joined.page.screenshot({ type: "png" });
      await writeFile(join(output, `observer-count-${count}.png`), observerBytes);
      assert.equal(sha256(nativeBytes), sha256(observerBytes), "Native and observer pixels differ at the same state");
      imagePairs.push({ count, nativeSha256: sha256(nativeBytes), observerSha256: sha256(observerBytes), bytes: nativeBytes.length });
    };
    await images(0);
    await native("native-click", `await browser.tab(${JSON.stringify(name)}).click("#increment"); console.log("NATIVE_CLICK_OK");`);
    assert.deepEqual(await snapshot(joined.page), { ...initial, count: 1 });
    await images(1);
    assert.notEqual(imagePairs[0]!.nativeSha256, imagePairs[1]!.nativeSha256);
    await record("native-click-visible-to-observer", { count: 1, imagePairs });

    const input = await joined.page.createCDPSession();
    const point = await joined.page.$eval("#increment", element => { const b = element.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await input.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...point });
    await input.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...point });
    await input.detach();
    await native("native-read-observer-click", `const s=await browser.tab(${JSON.stringify(name)}).evaluate(()=>window.fixtureSnapshot()); if(s.identity!==${JSON.stringify(initial.identity)}||s.count!==2) throw Error("Observer input changed a different document"); console.log("NATIVE_COUNT_2_SAME_DOCUMENT");`);
    assert.deepEqual(await snapshot(joined.page), { ...initial, count: 2 });
    await images(2);
    await record("observer-input-visible-to-native", { count: 2 });

    const stream = await joined.page.createCDPSession();
    const frame = Promise.withResolvers<{ data: string; metadata: unknown; sessionId: number }>();
    stream.once("Page.screencastFrame", event => frame.resolve(event));
    const frameTimeout = setTimeout(() => frame.reject(new Error("Actual native Page screencast produced no frame")), 5000);
    try {
      await stream.send("Page.startScreencast", { format: "png", maxWidth: 800, maxHeight: 600, everyNthFrame: 1 });
      const received = await frame.promise;
      assert(received.data.length > 0); assert(Buffer.from(received.data, "base64").length < 2 * 1024 * 1024);
      await writeFile(join(output, "native-screencast-frame.png"), Buffer.from(received.data, "base64"));
      await stream.send("Page.screencastFrameAck", { sessionId: received.sessionId });
      evidence.screencast = { frameSha256: sha256(Buffer.from(received.data, "base64")), metadata: received.metadata, acknowledged: true };
    } finally { clearTimeout(frameTimeout); await stream.send("Page.stopScreencast"); await stream.detach(); }
    await record("actual-native-screencast-frame-ack", evidence.screencast);

    observer.disconnect(); observer = undefined;
    assert.equal(ownedBrowser.connected, true); assert.equal(getTabsMapForTest().get(name)?.targetId, targetId);
    await native("native-after-observer-detach", `await browser.tab(${JSON.stringify(name)}).click("#increment"); console.log("NATIVE_ALIVE_WITHOUT_OBSERVER");`);
    joined = await attach(); observer = joined.browser;
    assert.deepEqual(await snapshot(joined.page), { ...initial, count: 3 });
    assert.equal(ownedBrowser.process()?.pid, nativePid);
    await images(3);
    evidence.imagePairs = imagePairs;
    await record("observer-reconnected-same-target-document-process", { targetId, count: 3, nativePid });
    observer.disconnect(); observer = undefined;
    await session.dispose(); nativeDisposed = true;
    const deadline = Date.now() + 5000;
    while (processHandle.exitCode === null && processHandle.signalCode === null && Date.now() < deadline) await Bun.sleep(10);
    assert(processHandle.exitCode !== null || processHandle.signalCode !== null, "Native session disposal left its Chrome process alive");
    assert.equal(getTabsMapForTest().size, 0);
    assert.equal(ownedBrowser.connected, false);
    assert.equal(await Bun.file(join(ownedProfile, "Default/Preferences")).exists(), false);
    assert.equal(await stat(ownedProfile).then(() => true, () => false), false);
    evidence.nativeCleanup = { processExited: true, exitCode: processHandle.exitCode, signal: processHandle.signalCode, tabMapEmpty: true, profileRemoved: true };
    await record("native-session-disposal-clean", evidence.nativeCleanup);
  } catch (error) { failure = error; }
  finally {
    observer?.disconnect();
    if (!nativeDisposed) await session?.dispose().catch(error => { failure ??= error; });
    // Failure cleanup affects only this experiment's empty-before-start registry.
    await releaseAllTabs({ kill: true }).catch(error => { failure ??= error; });
    if (ownedBrowser?.connected) await ownedBrowser.close().catch(error => { failure ??= error; });
    server?.stop(true); auth.close();
    await writeFile(join(output, "result.json"), JSON.stringify({ passed: failure === undefined,
      scope: "Real pinned native SDK Eval/browser prelude and Chrome target, separate CDP observer; no model/provider, desktop UI, remote host or production adapter",
      ompVersion: "18.1.10", ompCommit: "f241301c83726afe75a847e919b89977a54dafbe", testOnlyNativeEnumeration: true,
      backend: "SDK process-local headless Chromium", checks: checkpoints, ...evidence,
      ...(failure === undefined ? {} : { error: String(failure), stack: failure instanceof Error ? failure.stack : undefined }) }, null, 2) + "\n");
  }
  if (failure !== undefined) throw failure;
}

if (childMode) await child(); else await parent();
