/** Actual maintained supervisor cmux viewport/navigation sections with a controlled checked socket. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const nativeRoot = process.argv[2];
if (!nativeRoot) throw new Error("Usage: browser-cmux-navigation.ts <native-package-root>");
const path = `${nativeRoot}/src/tools/browser/tab-supervisor.ts`;
const cmuxTabPath = `${nativeRoot}/src/tools/browser/cmux/cmux-tab.ts`;
const [source, cmuxTabSource] = await Promise.all([readFile(path, "utf8"), readFile(cmuxTabPath, "utf8")]);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const section = (start: string, end: string) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`Missing source section ${start}`);
  return source.slice(a, b);
};
const selected = [
  section("function captureCmuxTabClient(", "async function acquireCmuxTab("),
  section("export async function captureTabViewportForOwner(", "const HUMAN_ACTION_TIMEOUT_MS"),
  section("const HUMAN_ACTION_TIMEOUT_MS", "/** Test-only accessor for the module-global tabs map."),
].join("\n");
const compile = (value: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(value.replace(/^export /gm, ""));
const ownerMethodStart = cmuxTabSource.indexOf("\tasync requestOwnerSurface(");
const ownerMethodEnd = cmuxTabSource.indexOf("\n\turl(): string", ownerMethodStart);
if (ownerMethodStart < 0 || ownerMethodEnd < 0) throw new Error("Missing actual CmuxTab owner surface method");
const ownerMethod = cmuxTabSource.slice(ownerMethodStart, ownerMethodEnd);
const CmuxOwnerMethod = new Function("ToolError", `${compile(`class Selected { readonly calls: unknown[] = []; async #request(method: string, params: object, timeoutMs: number) { this.calls.push({method,params,timeoutMs}); return {surface_id:"surface-1"}; } ${ownerMethod} }`)}; return Selected;`)(Error) as new () => {
  calls: unknown[]; requestOwnerSurface(method: "browser.back" | "browser.forward" | "browser.reload", params?: object, timeoutMs?: number): Promise<Record<string, unknown>>;
};
const selectedMethod = new CmuxOwnerMethod();
await selectedMethod.requestOwnerSurface("browser.back", {}, 321);
await selectedMethod.requestOwnerSurface("browser.forward");
await selectedMethod.requestOwnerSurface("browser.reload");
assert.deepEqual(selectedMethod.calls, [
  { method: "browser.back", params: {}, timeoutMs: 321 },
  { method: "browser.forward", params: {}, timeoutMs: 10_000 },
  { method: "browser.reload", params: {}, timeoutMs: 10_000 },
]);

const api = new Function("createHash", "Bun", `
  class ToolError extends Error {}
  class ToolAbortError extends Error {}
  const tabs = new Map(), retainedSessionTabs = new Map(), humanActions = new Map(), viewportCaptures = new Map(), activeOwnerNavigations = new Map();
  const assertTabNotReserved = () => {}, withTimeout = async promise => await promise;
  const activeNavigation = () => { throw new Error("Unexpected worker navigation"); };
  const executeRetainedTabRun = async () => { throw new Error("Unexpected retained worker run"); };
  const stopWorkerNavigation = async () => { throw new Error("Unexpected worker stop"); };
  const targetIdForTarget = async () => { throw new Error("Unexpected Puppeteer target"); };
  ${compile(selected)}
  return { tabs, retainedSessionTabs, rememberCmuxTabSource, captureTabViewportForOwner, readTabNavigationHistoryForOwner, performTabHumanActionForOwner, BrowserActionRejected };
`)(createHash, Bun) as {
  tabs: Map<string, any>;
  retainedSessionTabs: Map<string, any>;
  rememberCmuxTabSource(tab: any, client: any): void;
  captureTabViewportForOwner(owner: string, target: {name: string; targetId: string}): Promise<any>;
  readTabNavigationHistoryForOwner(owner: string, target: {name: string; targetId: string}): Promise<any>;
  performTabHumanActionForOwner(owner: string, target: {name: string; targetId: string}, context: any, action: any): Promise<any>;
};

const twoPixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==";
const calls: Array<{method: string; params: Record<string, unknown>; checkedReply?: boolean; generation?: number}> = [];
let currentUrl = "https://cmux.test/one", title = "One", timeOrigin = "1000", failSurface = false;
let holdNextEval: { started: () => void; release: Promise<void> } | undefined;
const client = {
  connectionGeneration: 7,
  async request(method: string, params: Record<string, unknown>, options?: {checkedReply?: boolean; connectionGeneration?: number}) {
    calls.push({ method, params: { ...params }, checkedReply: options?.checkedReply, generation: options?.connectionGeneration });
    if (method === "browser.eval" && holdNextEval) {
      const hold = holdNextEval; holdNextEval = undefined; hold.started(); await hold.release;
    }
    const surface_id = failSurface ? "foreign" : "surface-1";
    if (method === "browser.eval") return { surface_id, value: { url: currentUrl, title, timeOrigin, width: 2, height: 2, scrollX: 0, scrollY: 0 } };
    if (method === "browser.screenshot") return { surface_id, png_base64: twoPixelPng, width: 2, height: 2 };
    if (method === "browser.navigate") { currentUrl = String(params.url); title = "Two"; timeOrigin = "2000"; }
    if (method === "browser.back") { currentUrl = "https://cmux.test/one"; title = "One"; timeOrigin = "1000"; }
    if (method === "browser.forward") { currentUrl = "https://cmux.test/two"; title = "Two"; timeOrigin = "2000"; }
    return { surface_id };
  },
};
const browser = { kind: { kind: "cmux" }, client };
const tab = { name: "main", targetId: "surface-1", ownerSessionId: "owner-1", state: "alive", backend: "cmux", browser,
  cmuxTab: { async requestOwnerSurface(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000) {
    return await captured.request(method, { surface_id: "surface-1", ...params }, { timeoutMs });
  } }, cmuxOwnsSurface: false, kindTag: { kind: "cmux" }, info: {}, pending: new Map() };
api.tabs.set(tab.name, tab);
const captured = (() => {
  const originalClient = client, kind = browser.kind, generation = client.connectionGeneration;
  const assertCurrent = () => {
    if (browser.kind !== kind || kind.kind !== "cmux" || browser.client !== originalClient || originalClient.connectionGeneration !== generation) throw new Error("The original cmux tab connection is no longer available");
  };
  return { assertCurrent, async request(method: string, params: Record<string, unknown>, options?: object) {
    assertCurrent(); const result = await originalClient.request(method, params, { ...options, checkedReply: true, connectionGeneration: generation }); assertCurrent(); return result;
  } };
})();
api.rememberCmuxTabSource(tab, captured);

const target = { name: "main", targetId: "surface-1" };
const frame = await api.captureTabViewportForOwner("owner-1", target);
assert.equal(frame.context.opaqueHistoryTraversal, true);
assert.equal(frame.context.navigation, undefined);
assert.equal(frame.url, "https://cmux.test/one");
assert.equal(frame.data[0], 0xff); assert.equal(frame.data[1], 0xd8);
assert(calls.every(call => call.checkedReply && call.generation === 7));
await assert.rejects(api.readTabNavigationHistoryForOwner("owner-1", target), /history is not supported for cmux/i);

let context = frame.context;
for (const action of [{ type: "navigate", url: "https://cmux.test/two" }, { type: "back" }, { type: "forward" }, { type: "reload" }] as const) {
  const result = await api.performTabHumanActionForOwner("owner-1", target, context, action);
  context = result.context;
  assert.equal(context.opaqueHistoryTraversal, true);
}
assert.deepEqual(calls.filter(call => ["browser.navigate", "browser.back", "browser.forward", "browser.reload"].includes(call.method)).map(call => call.method),
  ["browser.navigate", "browser.back", "browser.forward", "browser.reload"]);
await assert.rejects(api.performTabHumanActionForOwner("owner-1", target, context, { type: "stop" }), /Stop loading is unavailable for cmux/);
await assert.rejects(api.performTabHumanActionForOwner("owner-1", target, context, { type: "click", x: 0, y: 0 }), /does not support page input/);

const beforeWrongSurface = calls.length; failSurface = true;
await assert.rejects(api.performTabHumanActionForOwner("owner-1", target, context, { type: "reload" }), /different browser surface/);
assert.equal(calls.slice(beforeWrongSurface).some(call => call.method === "browser.reload"), false, "surface mismatch must reject before mutation");
failSurface = false;
const beforeReplacement = calls.length;
browser.client = { ...client };
await assert.rejects(api.performTabHumanActionForOwner("owner-1", target, context, { type: "reload" }), /original cmux tab connection/);
assert.equal(calls.length, beforeReplacement, "replacement client must receive no request");

// A retained cmux owner has no ordinary browser-handle lookup. Its exact
// CmuxTab carries the captured request transport and surface id across runs.
browser.client = client;
api.tabs.delete(tab.name);
const retained = {
  name: tab.name, targetId: tab.targetId, ownerSessionId: tab.ownerSessionId, state: "alive", backend: "cmux",
  cmuxTab: tab.cmuxTab, safeDir: "/tmp",
};
api.retainedSessionTabs.set(retained.name, retained);
const retainedFrame = await api.captureTabViewportForOwner("owner-1", target);
assert.equal(retainedFrame.context.opaqueHistoryTraversal, true);
const retainedResult = await api.performTabHumanActionForOwner("owner-1", target, retainedFrame.context, { type: "reload" });
assert.equal(retainedResult.context.opaqueHistoryTraversal, true);
let evalStarted!: () => void, releaseEval!: () => void;
const evalStartedPromise = new Promise<void>(resolve => { evalStarted = resolve; });
const releaseEvalPromise = new Promise<void>(resolve => { releaseEval = resolve; });
holdNextEval = { started: evalStarted, release: releaseEvalPromise };
const beforeRetainedReplacement = calls.length;
const staleRetainedAction = api.performTabHumanActionForOwner("owner-1", target, retainedResult.context, { type: "reload" });
await evalStartedPromise;
api.retainedSessionTabs.set(retained.name, { ...retained });
releaseEval();
await assert.rejects(staleRetainedAction, /retained cmux browser source is no longer current/);
assert.equal(calls.slice(beforeRetainedReplacement).some(call => call.method === "browser.reload"), false, "replacement retained owner must receive no mutating request");

console.log(JSON.stringify({
  source: { path, sha256: hash(source), selectedSha256: hash(selected), cmuxTabPath, cmuxTabSha256: hash(cmuxTabSource), ownerMethodSha256: hash(ownerMethod) },
  counts: { checks: 24, nativeMethods: calls.map(call => call.method) },
  result: "PASS",
  limits: "Actual maintained OMP supervisor sections and Bun image decoder/encoder with a controlled checked cmux socket. No installed cmux binary/server, physical surface, socket transport, search-provider autocomplete, native history listing, Stop, resize, or page-input proof.",
}, null, 2));
