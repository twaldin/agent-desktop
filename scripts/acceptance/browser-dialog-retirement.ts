/** Dialog retirement acceptance using complete selected WorkerCore and actual channel; controlled dependencies only. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const [workerPath, channelPath, protocolArg] = process.argv.slice(2);
if (!workerPath || !channelPath) throw new Error("Usage: browser-dialog-retirement.ts <tab-worker.ts> <worker-cdp-channel.ts> [tab-protocol.ts]");
const protocolPath = protocolArg ?? path.join(path.dirname(workerPath), "tab-protocol.ts");
const workerSource = await readFile(workerPath, "utf8"), channelSource = await readFile(channelPath, "utf8"), protocolSource = await readFile(protocolPath, "utf8");
const transform = (source: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^import\b[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""));
type Frame = { type: string; [key: string]: unknown };
type Cdp = { send(raw: string): void; onmessage?: (raw: string) => void; onclose?: () => void; close(): void; dispose(): Promise<void> };
type Parent = { start(): void; receive(frame: unknown): boolean; dispose(): Promise<void> };
type Core = { retire(): Promise<void>; close(): Promise<void>; abort(error: unknown): Promise<void> };
const { ParentWorkerCdpChannel, WorkerCdpChannel } = new Function(`${transform(channelSource)}\nreturn { ParentWorkerCdpChannel, WorkerCdpChannel };`)() as {
  ParentWorkerCdpChannel: new (channel: string, upstream: Cdp, post: (frame: Frame) => void) => Parent;
  WorkerCdpChannel: unknown;
};
const ticks = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const errors = (value: unknown): string[] => value instanceof AggregateError ? value.errors.flatMap(errors) : [value instanceof Error ? value.message : String(value)];
function track(promise: Promise<unknown>) {
  let result: { ok: boolean; errors?: string[] } | undefined;
  void promise.then(() => { result = { ok: true }; }, error => { result = { ok: false, errors: errors(error) }; });
  return { pending: () => !result, result: () => result };
}
function harness(hold?: "loader" | "connect" | "create" | "goto" | "page" | "title" | "init-cleanup") {
  const channel = "original-worker-attempt", messages: Frame[] = [], commands: string[] = [], gates: Array<() => void> = [];
  let listener: ((frame: Frame) => void) | undefined, listeners = 0, removed = 0, guards = 0, disconnected = 0, pageCloses = 0, created = false, loaderCalls = 0;
  const dialogPolicies: string[] = [], dialogOutcomes: string[] = []; const dialogHandlers = new Set<(dialog: any) => unknown>();
  let dialogHandler: ((dialog: any) => unknown) | undefined, dialogAction: "resolve" | "hold" | "reject" | "sync-throw" | "retire" = "resolve", dialogGate = Promise.withResolvers<void>(), pageTargetId = "original-page"; let holdPage = false, holdTitle = false;
  const paused = Promise.withResolvers<void>(); gates.push(() => paused.resolve());
  const nativeDrain = Promise.withResolvers<void>(); gates.push(() => nativeDrain.resolve());
  let holdDrain = false, drainError: Error | undefined, connectFailure: Error | undefined, navigationFailure = false, initCleanupFailure = false;
  let connection: Cdp | undefined, next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let postEffect: (frame: Frame) => void = () => {};
  let onConnectionClose = () => {}, runStarted = 0, runCleanup = 0, holdRunCleanup = false;
  const userRun = Promise.withResolvers<unknown>(), runDrain = Promise.withResolvers<void>();
  gates.push(() => { userRun.resolve(undefined); runDrain.resolve(); });
  const rpc = (method: string, params: Record<string, unknown> = {}) => {
    commands.push(method);
    if (!connection) return Promise.resolve(method === "Target.createTarget" ? { targetId: "original-page" } : {});
    const done = Promise.withResolvers<unknown>(), id = ++next; pending.set(id, done);
    connection.send(JSON.stringify({ id, method, params })); return done.promise;
  };
  const upstream: Cdp = {
    send(raw) {
      const request = JSON.parse(raw) as { id: number; method: string };
      void (async () => {
        if ((hold === "connect" && request.method === "Browser.getVersion") || (hold === "create" && request.method === "Target.createTarget") || (hold === "goto" && request.method === "Page.navigate")) await paused.promise;
        if (request.method === "Target.createTarget") created = true;
        upstream.onmessage?.(JSON.stringify({ id: request.id, result: request.method === "Target.createTarget" ? { targetId: "original-page" } : {} }));
      })();
    },
    close() { throw new Error("Must join upstream dispose instead"); },
    async dispose() { if (holdDrain) await nativeDrain.promise; if (drainError) throw drainError; },
  };
  const session = { send: rpc, detach: async () => {} };
  const page = {
    target: () => ({ _targetId: pageTargetId }), isClosed: () => false, on: (event: string, handler?: unknown) => { if (event === "dialog" && handler) { dialogPolicies.push("installed"); dialogHandler = handler as (dialog: any) => unknown; dialogHandlers.add(dialogHandler); } return page; }, off: (event: string, handler: unknown) => { if (event === "dialog") dialogHandlers.delete(handler as (dialog: any) => unknown); return page; },
    async setRequestInterception() { runCleanup++; if (holdRunCleanup) await runDrain.promise; },
    once: () => page, removeAllListeners: () => page,
    mainFrame: () => ({}), viewport: () => ({ width: 800, height: 600 }), url: () => "https://original.test/",
    async title() { if (hold === "title" || holdTitle) await paused.promise; return "Original"; },
    async goto(url: string) { if (navigationFailure) throw new Error("Original init navigation failed"); return rpc("Page.navigate", { url }); },
    async close() { pageCloses++; if (hold === "init-cleanup") await paused.promise; if (initCleanupFailure) throw new Error("Original init page cleanup failed"); await rpc("Target.closeTarget", { targetId: "original-page" }); },
    async createCDPSession() { return session; },
  };
  const target = { _targetId: "original-page", async page() { if (hold === "page" || holdPage) await paused.promise; return page; }, async createCDPSession() { return session; } };
  const browser = {
    connected: true, target: () => target, targets: () => [target], waitForTarget: async () => target,
    disconnect() { disconnected++; browser.connected = false; connection?.close(); },
  };
  const connects: Record<string, unknown>[] = [];
  const dependencies: Record<string, unknown> = {
    Bun: { sleep: async () => {} },
    AbortSignal: { timeout: () => new AbortController().signal, any: AbortSignal.any.bind(AbortSignal) },
    JsRuntime: class { setCwd() {} setRunScope() {} run() { runStarted++; return userRun.promise; } },
    RunOutput: class { finish() { return []; } pushText() {} pushDisplay() {} },
    throwIfAborted: (signal: AbortSignal) => { if (signal.aborted) throw signal.reason; },
    bindRunFacade: (value: unknown) => value,
    withBrowserPromiseCombinatorTracking: (_owner: unknown, _callback: unknown, work: () => unknown) => work(),
    withTimeout: (promise: Promise<unknown>) => promise,
    cloneSafe: structuredClone,
    WorkerCdpChannel, CELL_BUDGET_SLACK_MS: 100, BROWSER_PROTOCOL_TIMEOUT_MS: 1000, DEFAULT_VIEWPORT: { width: 800, height: 600 },
    postmortem: { interceptUnhandledRejections: () => { guards++; return () => { guards--; }; }, markExpectedCleanupError: (error: unknown) => error, isExpectedCleanupError: () => false },
    installBrowserWorkerRejectionGuard: () => { guards++; return () => { guards--; }; },
    ToolError: class ToolError extends Error {}, ToolAbortError: class ToolAbortError extends Error {},
    async loadPuppeteerInWorker() {
      loaderCalls++; if (hold === "loader") await paused.promise;
      return { async connect(options: Record<string, unknown>) {
        connects.push(options); if (connectFailure) throw connectFailure;
        connection = options.transport as Cdp | undefined;
        if (connection) {
          connection.onmessage = raw => { const frame = JSON.parse(raw); const done = pending.get(frame.id); if (!done) return; pending.delete(frame.id); if (frame.error) done.reject(new Error(frame.error.message)); else done.resolve(frame.result); };
          connection.onclose = () => { onConnectionClose(); browser.connected = false; for (const done of pending.values()) done.reject(new Error("Original channel closed")); pending.clear(); };
          await rpc("Browser.getVersion");
        }
        return browser;
      } };
    },
    applyStealthPatches: async () => { commands.push("stealth"); }, applyViewport: async () => { commands.push("viewport"); },
  };
  const WorkerCore = new Function(...Object.keys(dependencies), `${transform(workerSource)}\nreturn WorkerCore;`)(...Object.values(dependencies)) as new (port: unknown, isolated: boolean) => Core;
  let parent: Parent;
  const port = {
    send(frame: Frame) { messages.push(structuredClone(frame)); if (frame.type === "worker-cdp") parent.receive(frame); postEffect(frame); },
    onMessage(callback: (frame: Frame) => void) { assert.equal(listeners, 0, "only one original inbox subscription"); listeners++; listener = callback; return () => { listeners--; removed++; listener = undefined; }; },
    close() { commands.push("port.close"); },
  };
  const core = new WorkerCore(port, false);
  parent = new ParentWorkerCdpChannel(channel, upstream, frame => listener?.(frame));
  const action = (kind: "accept" | "dismiss") => {
    dialogOutcomes.push(kind);
    if (dialogAction === "sync-throw") throw new Error("Dialog action synchronous failure");
    if (dialogAction === "retire") { void core.retire(); return dialogGate.promise; }
    if (dialogAction === "reject") return Promise.reject(new Error("Dialog action asynchronous failure"));
    if (dialogAction === "hold") return dialogGate.promise;
    return Promise.resolve();
  };
  return {
    core, parent, messages, commands, connects, browser,
    input(frame: Frame) { listener?.(frame); },
    init(mode: "headless" | "attach" = "headless", owned = true) {
      listener?.({ type: "init", payload: { mode, ...(owned ? { cdpChannel: channel } : { browserWSEndpoint: "ws://legacy-only.test/" }), safeDir: "/controlled", targetId: "original-page", timeoutMs: 1000, url: "https://destination.test/" } });
      parent.start();
    },
    initRetained(overrides: Record<string, unknown> = {}) {
      const payload: Record<string, unknown> = { mode: "retained", cdpChannel: channel, safeDir: "/controlled", targetId: "original-page", timeoutMs: 1000, activateForScreenshot: false };
      Object.assign(payload, overrides); listener?.({ type: "init", payload }); parent.start(); return payload;
    },
    release() { paused.resolve(); },
    holdDrain() { holdDrain = true; return nativeDrain; },
    failDrain() { drainError = new Error("Original parent detach failed"); },
    failInitNavigation(cleanupFails = false) { navigationFailure = true; initCleanupFailure = cleanupFails; },
    failConnect() { connectFailure = new Error("Owned connect refused"); },
    effect(callback: typeof postEffect) { postEffect = callback; },
    onConnectionClose(callback: () => void) { onConnectionClose = callback; },
    holdRunCleanup() { holdRunCleanup = true; return runDrain; },
    resolveRun() { userRun.resolve("done"); },
    stats: () => ({ listeners, removed, guards, disconnected, pageCloses, created, runStarted, runCleanup, loaderCalls, dialogPolicies: [...dialogPolicies], dialogOutcomes: [...dialogOutcomes], activeDialogHandlers: dialogHandlers.size }),
    setDialogAction(value: "resolve" | "hold" | "reject" | "sync-throw" | "retire") { dialogAction = value; dialogGate = Promise.withResolvers<void>(); return dialogGate; },
    triggerDialog() { for (const handler of [...dialogHandlers]) handler({ type: () => "confirm", message: () => "controlled", accept: () => action("accept"), dismiss: () => action("dismiss") }); },
    setPageTarget(value: string) { pageTargetId = value; }, holdPage() { holdPage = true; }, holdTitle() { holdTitle = true; },
    async finish() {
      dialogGate.resolve();
      for (const release of gates) release();
      await ticks();
      await Promise.allSettled([core.retire(), parent.dispose()]); await ticks();
    },
  };
}
const unhandled: unknown[] = [];
const onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on("unhandledRejection", onUnhandled);
const passed: string[] = [], failed: Array<{ name: string; error: string }> = [];
async function scenario(name: string, hold: Parameters<typeof harness>[0], action: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness(hold);
  try { await action(h); passed.push(name); }
  catch (error) { failed.push({ name, error: errors(error).join("; ") }); }
  finally { await h.finish(); }
}
for (const mode of ["headless", "attach"] as const) {
  await scenario(`owned ${mode} uses actual channel and keeps normal startup`, undefined, async h => {
    h.init(mode); await ticks(); assert.equal(h.connects.length, 1); assert(h.connects[0]!.transport); assert.equal(h.connects[0]!.browserWSEndpoint, undefined);
    assert(h.messages.some(m => m.type === "ready")); assert(h.commands.includes("Page.navigate"));
    if (mode === "headless") { assert(h.messages.some(m => m.type === "page-created")); assert(h.commands.includes("stealth")); }
    else assert.equal(h.commands.includes("Target.createTarget"), false);
    assert.equal(h.stats().listeners, 1);
  });
}
await scenario("legacy endpoint startup remains explicit and compatible", undefined, async h => {
  h.init("attach", false); await ticks(); assert.equal(h.connects[0]!.browserWSEndpoint, "ws://legacy-only.test/"); assert.equal(h.connects[0]!.transport, undefined);
  assert(h.messages.some(m => m.type === "ready"));
});
for (const policy of ["accept", "dismiss"] as const) {
  await scenario(`held ${policy} dialog action keeps retirement pending until native settlement`, undefined, async h => {
    h.initRetained({ dialogs: policy }); await ticks(); const gate = h.setDialogAction("hold"); h.triggerDialog(); await ticks();
    const done = track(h.core.retire()); await ticks(); const pending = done.pending(), disconnected = h.stats().disconnected;
    gate.resolve(); await ticks(); assert.equal(pending,true); assert.equal(disconnected,0); assert.equal(done.result()?.ok, true); assert.equal(h.stats().dialogOutcomes.at(-1), policy); const count=h.stats().dialogOutcomes.length; h.triggerDialog(); await ticks(); assert.equal(h.stats().dialogOutcomes.length,count);
  });
  await scenario(`rejected held ${policy} action survives retirement as an operational error`, undefined, async h => {
    h.initRetained({ dialogs: policy }); await ticks(); const gate = h.setDialogAction("hold"); h.triggerDialog(); await ticks();
    const done = track(h.core.retire()); gate.reject(new Error("held dialog failure")); await ticks(); assert.equal(done.result()?.ok, false);
    assert.match(done.result()?.errors?.join(" ") ?? "", /held dialog failure/); assert.match(JSON.stringify(h.messages.filter(m => m.type === "closed")), /held dialog failure/); const repeated = track(h.core.retire()); await ticks(); assert.equal(repeated.result()?.ok, false);
  });
}
await scenario("synchronous dialog retirement before a native promise is returned remains drainable", undefined, async h => {
  h.initRetained({ dialogs: "accept" }); await ticks(); const gate=h.setDialogAction("retire"); h.triggerDialog(); await ticks();
  const done = track(h.core.retire()); await ticks(); const pending=done.pending(), disconnected=h.stats().disconnected; gate.resolve(); await ticks(); assert.equal(pending,true); assert.equal(disconnected,0); assert.equal(done.result()?.ok,true);
});
for (const operation of ["close","abort"] as const) {
  await scenario(`explicit ${operation} joins held dialog action`, undefined, async h => {
    h.initRetained({dialogs:"accept"}); await ticks(); const gate=h.setDialogAction("hold"); h.triggerDialog();
    const done=track(operation==="close"?h.core.close():h.core.abort(new Error("Port lost during dialog")));
    await ticks(); const pending=done.pending(); gate.resolve(); await ticks();
    assert.equal(pending,true); assert.equal(done.result()?.ok,operation==="close"); assert.equal(h.stats().pageCloses,0);
    if(operation==="abort") assert.match(done.result()?.errors?.join(" ")??"",/Port lost during dialog/);
  });
}
await scenario("dialog failure and parent drain failure remain independently retained", undefined, async h => {
  h.initRetained({dialogs:"dismiss"}); await ticks(); const gate=h.setDialogAction("hold"); h.triggerDialog(); h.failDrain();
  const done=track(h.core.retire()); gate.reject(new Error("Independent dialog failure")); await ticks();
  assert.equal(done.result()?.ok,false); const text=done.result()?.errors?.join(" ")??"";
  assert.match(text,/Independent dialog failure/); assert.match(text,/Original parent detach failed/);
});
await scenario("live synchronous dialog action failure logs once without retained cleanup failure", undefined, async h => {
  h.initRetained({ dialogs: "dismiss" }); await ticks(); h.setDialogAction("sync-throw"); h.triggerDialog(); await ticks();
  assert.equal(h.messages.filter(m => m.type === "log" && JSON.stringify(m).includes("Dialog auto-handler failed")).length, 1); const done = track(h.core.retire()); await ticks(); assert.equal(done.result()?.ok, true);
});
await scenario("live asynchronous dialog action rejection logs once without retained cleanup failure", undefined, async h => {
  h.initRetained({ dialogs: "dismiss" }); await ticks(); h.setDialogAction("reject"); h.triggerDialog(); await ticks();
  assert.equal(h.messages.filter(m => m.type === "log" && JSON.stringify(m).includes("Dialog auto-handler failed")).length, 1); const done = track(h.core.retire()); await ticks(); assert.equal(done.result()?.ok, true);
});
await scenario("report callback retirement preserves the original dialog error", undefined, async h => {
  h.initRetained({ dialogs: "accept" }); await ticks(); h.setDialogAction("reject"); h.effect(frame => { if (frame.type === "log") void h.core.retire(); }); h.triggerDialog(); await ticks();
  const done = track(h.core.retire()); await ticks(); assert.equal(done.result()?.ok, false); assert.match(done.result()?.errors?.join(" ") ?? "", /Dialog action asynchronous failure/);
});
await scenario("report callback throw retains both original and reporting errors", undefined, async h => {
  h.initRetained({ dialogs: "accept" }); await ticks(); h.setDialogAction("reject"); h.effect(frame => { if (frame.type === "log") throw new Error("dialog report failure"); }); h.triggerDialog(); await ticks();
  const done = track(h.core.retire()); await ticks(); assert.equal(done.result()?.ok, false); const text = done.result()?.errors?.join(" ") ?? ""; assert.match(text, /Dialog action asynchronous failure/); assert.match(text, /dialog report failure/);
});

await scenario("retained mode attaches the exact existing page without setup side effects", undefined, async h => {
  h.initRetained({ dialogs: "dismiss" }); await ticks();
  assert.equal(h.connects.length, 1); assert(h.connects[0]!.transport); assert.equal(h.connects[0]!.browserWSEndpoint, undefined);
  assert(h.messages.some(m => m.type === "ready")); assert.equal(h.messages.some(m => m.type === "page-created"), false);
  for (const forbidden of ["Target.createTarget", "Page.navigate", "stealth", "viewport", "OMP.claimTarget"]) assert.equal(h.commands.includes(forbidden), false, forbidden);
  assert.equal(h.stats().pageCloses, 0); await h.triggerDialog(); assert.deepEqual(h.stats().dialogOutcomes, ["dismiss"]);
});
for (const invalid of [
  { url: "https://forbidden.test/" }, { recover: true }, { browserWSEndpoint: "ws://forbidden" },
  { activateForScreenshot: undefined }, { activateForScreenshot: "false" },
  { cdpChannel: "" }, { targetId: "" }, { safeDir: "" }, { timeoutMs: 0 }, { dialogs: "invalid" }, { viewport: {width:1,height:1} },
] as const) {
  await scenario(`retained rejects ${JSON.stringify(invalid)} before the loader`, undefined, async h => {
    h.initRetained(invalid as Record<string, unknown>); await ticks();
    assert.equal(h.stats().loaderCalls, 0); assert.equal(h.messages.some(m => m.type === "ready"), false);
    assert.match(JSON.stringify(h.messages.filter(m => m.type === "init-failed")), /Invalid retained browser worker initialization/);
  });
}
await scenario("retirement during retained scalar capture prevents the loader", undefined, async h => {
  const payload = {mode:"retained",cdpChannel:"original-worker-attempt",safeDir:"/controlled",targetId:"original-page",timeoutMs:1000,
    get activateForScreenshot() { void h.core.retire().catch(() => {}); return false; }};
  h.input({type:"init",payload}); await ticks();
  assert.equal(h.stats().loaderCalls,0); assert.equal(h.messages.some(m => m.type === "ready"),false);
});
await scenario("retained omitted dialog policy observes without accepting or dismissing", undefined, async h => {
  h.initRetained({activateForScreenshot:true}); await ticks(); assert(h.messages.some(m => m.type === "ready"));
  await h.triggerDialog(); assert.deepEqual(h.stats().dialogOutcomes,[]);
});
await scenario("retained copies the dispatched scalar payload before its held loader resumes", "loader", async h => {
  const payload = h.initRetained({ dialogs: "accept", activateForScreenshot: false }); await ticks();
  payload.targetId = "mutated-target"; payload.dialogs = "dismiss"; payload.activateForScreenshot = true;
  h.release(); await ticks(); assert(h.messages.some(m => m.type === "ready")); assert.equal(h.messages.some(m => m.type === "init-failed"), false);
  await h.triggerDialog(); assert.deepEqual(h.stats().dialogOutcomes, ["accept"]);
});
await scenario("retained target mismatch fails before readiness without creating or closing a page", undefined, async h => {
  h.initRetained({ targetId: "other-target" }); await ticks();
  assert.equal(h.messages.some(m => m.type === "ready"), false); assert.equal(h.messages.some(m => m.type === "page-created"), false);
  assert.equal(h.stats().pageCloses, 0); assert.match(JSON.stringify(h.messages.filter(m => m.type === "init-failed")), /attached browser|different target|changed before readiness/i);
});
for (const seam of ["page", "title"] as const) {
  await scenario(`retained refuses an exact page target replacement while ${seam} awaits`, undefined, async h => {
    if (seam === "page") h.holdPage(); else h.holdTitle(); h.initRetained(); await ticks(); h.setPageTarget("replacement-target"); h.release(); await ticks();
    assert.equal(h.messages.some(m => m.type === "ready"), false); assert.equal(h.messages.some(m => m.type === "page-created"), false);
    assert.equal(h.stats().pageCloses, 0); assert.match(JSON.stringify(h.messages.filter(m => m.type === "init-failed")), /different target|changed before readiness/i);
  });
}
await scenario("retained close drains its original channel and never closes the captured page", undefined, async h => {
  h.initRetained(); await ticks(); const drain = h.holdDrain(); const done = track(h.core.close()); await ticks();
  assert(done.pending()); assert.equal(h.stats().pageCloses, 0); assert.equal(h.messages.some(m => m.type === "page-created"), false);
  drain.resolve(); await ticks(); assert.equal(done.result()?.ok, true); assert.equal(h.stats().pageCloses, 0);
});
await scenario("retained channel drain failure remains observable and preserves the captured page", undefined, async h => {
  h.initRetained(); await ticks(); h.failDrain(); const done = track(h.core.retire()); await ticks();
  assert.equal(done.result()?.ok, false); assert.match(done.result()?.errors?.join(" ") ?? "", /Original parent detach failed/);
  assert.equal(h.stats().pageCloses, 0); assert.equal(h.messages.some(m => m.type === "page-created"), false);
});

await scenario("owned connect failure never retries by endpoint", undefined, async h => {
  h.failConnect(); h.init(); await ticks(); assert.equal(h.connects.length, 1); assert(h.messages.some(m => m.type === "init-failed")); assert.equal(h.messages.some(m => m.type === "ready"), false);
});
await scenario("retire during loader prevents late connect and joins initialization", "loader", async h => {
  h.init(); await ticks(); const retired = track(h.core.retire()); await ticks(); assert(retired.pending());
  h.release(); await ticks(); assert.equal(retired.result()?.ok, true); assert.equal(h.connects.length, 0); assert.equal(h.messages.some(m => m.type === "ready"), false);
});
for (const stage of ["connect", "goto", "page", "title"] as const) {
  await scenario(`retire while ${stage} awaits suppresses late publication`, stage, async h => {
    h.init(stage === "page" ? "attach" : "headless"); await ticks(); const retired = track(h.core.retire()); h.release(); await ticks();
    assert.equal(retired.pending(), false); assert.equal(h.messages.some(m => m.type === "ready"), false); assert.equal(h.stats().pageCloses, 0);
  });
}
await scenario("retire initialized page preserves target and rejects later work", undefined, async h => {
  h.init(); await ticks(); await h.core.retire(); const before = h.commands.length;
  h.input({ type: "run", id: "late", code: "should not run", timeoutMs: 1000, session: { cwd: "/controlled" } }); await ticks();
  assert.equal(h.commands.length, before); assert.equal(h.stats().pageCloses, 0); assert.equal(h.stats().listeners, 0); assert.equal(h.stats().guards, 0);
});
await scenario("normal close closes headless page then waits original parent drain", undefined, async h => {
  h.init(); await ticks(); const gate = h.holdDrain(); h.input({ type: "close" }); await ticks();
  assert.equal(h.stats().pageCloses, 1); assert.equal(h.messages.some(m => m.type === "closed"), false);
  gate.resolve(); await ticks(); assert(h.messages.some(m => m.type === "closed"));
});
await scenario("failed parent drain remains an error on repeated retirement", undefined, async h => {
  h.init(); await ticks(); h.failDrain(); const one = track(h.core.retire()); await ticks();
  assert.equal(one.result()?.ok, false); assert.match(one.result()?.errors?.join(" ") ?? "", /Original parent detach failed/);
  const again = track(h.core.retire()); await ticks(); assert.equal(again.result()?.ok, false);
});
await scenario("retire drains sent creation and preserves exact late orphan receipt", "create", async h => {
  h.init(); await ticks(); assert(h.commands.includes("Target.createTarget"));
  const done = track(h.core.retire()); await ticks(); assert(done.pending());
  h.release(); await ticks(); assert.equal(done.result()?.ok, true);
  assert.deepEqual(h.messages.filter(m => m.type === "page-created").map(m => m.targetId), ["original-page"]);
  assert.equal(h.messages.some(m => m.type === "ready"), false); assert.equal(h.stats().pageCloses, 0);
});
await scenario("normal close during sent creation closes reported original orphan", "create", async h => {
  h.init(); await ticks(); const done = track(h.core.close()); await ticks(); assert(done.pending());
  h.release(); await ticks(); assert.equal(done.result()?.ok, true);
  assert.equal(h.messages.filter(m => m.type === "page-created").length, 1);
  assert.equal(h.commands.filter(c => c === "Target.closeTarget").length, 1);
  assert.equal(h.messages.some(m => m.type === "ready"), false);
});
await scenario("malformed channel retires facade before reentrant Puppeteer close callback", undefined, async h => {
  h.init(); await ticks(); h.onConnectionClose(() => h.input({ type: "close" }));
  h.input({ type: "worker-cdp", channel: "original-worker-attempt", kind: "data", sequence: 99, data: "{}" });
  await ticks(); assert.equal(h.stats().pageCloses, 0);
  const done = track(h.core.retire()); await ticks(); assert.equal(done.result()?.ok, false);
  assert.match(done.result()?.errors?.join(" ") ?? "", /Invalid worker CDP message/);
});
await scenario("retire active run joins actual run-page cleanup before parent detach", undefined, async h => {
  h.init(); await ticks(); const cleanup = h.holdRunCleanup();
  h.input({ type: "run", id: "active", name: "original", code: "controlled", timeoutMs: 1000, session: { cwd: "/controlled" } });
  await ticks(); assert.equal(h.stats().runStarted, 1);
  const done = track(h.core.retire()); await ticks(); assert.equal(h.stats().runCleanup, 1); assert(done.pending());
  assert.equal(h.stats().disconnected, 0); assert.equal(h.messages.some(m => m.type === "closed"), false);
  cleanup.resolve(); h.resolveRun(); await ticks(); assert.equal(done.result()?.ok, true);
  assert.equal(h.messages.some(m => m.type === "result"), false); assert.equal(h.stats().pageCloses, 0);
});
await scenario("duplicate init cannot open a second owner connection", undefined, async h => {
  h.init(); await ticks(); h.init("attach", false); await ticks(); assert.equal(h.connects.length, 1);
  assert(h.connects[0]!.transport); assert.equal(h.messages.filter(m => m.type === "ready").length, 1);
});
await scenario("explicit lost port rejects retirement without invented drain success", "loader", async h => {
  h.init(); await ticks(); const done = track(h.core.abort(new Error("Original worker port lost")));
  h.release(); await ticks(); assert.equal(done.result()?.ok, false); assert.match(done.result()?.errors?.join(" ") ?? "", /Original worker port lost/);
  assert.equal(h.messages.some(m => m.type === "closed"), false); assert.equal(h.connects.length, 0);
});
// The operational error precedes retirement; only its page cleanup is held.
for (const owned of [true, false]) {
  for (const cleanupFails of [false, true]) {
    await scenario(`init failure retained across cleanup retirement owned=${owned} cleanupFails=${cleanupFails}`, "init-cleanup", async h => {
      h.failInitNavigation(cleanupFails); h.init("headless", owned); await ticks();
      assert.equal(h.stats().pageCloses, 1); assert.equal(h.messages.some(m => m.type === "init-failed"), false);
      const done = track(h.core.retire()); await ticks(); const pendingBeforeRelease = done.pending();
      h.release(); await ticks();
      assert.equal(pendingBeforeRelease, true); assert.equal(done.result()?.ok, false);
      assert.match(done.result()?.errors?.join(" ") ?? "", /Original init navigation failed/);
      if (cleanupFails) assert.match(done.result()?.errors?.join(" ") ?? "", /Original init page cleanup failed/);
      assert.equal(h.messages.some(m => m.type === "init-failed" || m.type === "ready"), false);
      const closed = h.messages.filter(m => m.type === "closed"); assert.equal(closed.length, 1);
      assert.match(JSON.stringify(closed[0]), /Original init navigation failed/);
      const repeated = track(h.core.retire()); await ticks(); assert.equal(repeated.result()?.ok, false);
      assert.match(repeated.result()?.errors?.join(" ") ?? "", /Original init navigation failed/);
      assert.equal(h.stats().pageCloses, 1); assert.equal(h.stats().listeners, 0); assert.equal(h.stats().guards, 0);
    });
  }
  await scenario(`nonretired init failure remains a single report owned=${owned}`, "init-cleanup", async h => {
    h.failInitNavigation(); h.init("headless", owned); await ticks(); assert.equal(h.stats().pageCloses, 1);
    h.release(); await ticks(); const reports = h.messages.filter(m => m.type === "init-failed");
    assert.equal(reports.length, 1); assert.match(JSON.stringify(reports[0]), /Original init navigation failed/);
    const done = track(h.core.retire()); await ticks(); assert.equal(done.result()?.ok, true);
    assert.equal(h.messages.some(m => m.type === "ready"), false); assert.equal(h.stats().pageCloses, 1);
  });
}
// Observe escaped callback rejections as fixture failures, never as passing cleanup.
await new Promise<void>(resolve => setImmediate(resolve));
await new Promise<void>(resolve => setImmediate(resolve));
process.removeListener("unhandledRejection", onUnhandled);
for (const error of unhandled) failed.push({name:"escaped controlled callback rejection",error:errors(error).join("; ")});
console.log(JSON.stringify({ workerPath, channelPath, protocolPath, workerSha256: createHash("sha256").update(workerSource).digest("hex"), channelSha256: createHash("sha256").update(channelSource).digest("hex"), protocolSha256: createHash("sha256").update(protocolSource).digest("hex"), counts: { pass: passed.length, fail: failed.length }, passed, failed, limits: "Complete selected WorkerCore and channel; type/runtime imports removed, injected loader/browser/page/CDP operations. Existing single dispatcher and actual channel classes exercised, no actual Worker/SDK/IPC/socket/native/timeouts. Controlled dialog callbacks, errors, report callbacks, and parent drain are exercised. Screenshot focus/capture and parent ownership leases remain separate." }, null, 2));
if (failed.length) process.exitCode = 1;
