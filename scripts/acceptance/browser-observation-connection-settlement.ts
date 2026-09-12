/** Actual retained readers and selected supervisor; controlled connection state and lease settlement only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const positional = args.filter(arg => arg !== "--pair");
const nativeRoot = positional[0];
if (!nativeRoot || positional.length > 2 || args.some(arg => arg.startsWith("--") && arg !== "--pair")) {
  throw new Error("Usage: browser-observation-connection-settlement.ts <nativeRoot> [supervisorPath] [--pair]");
}
// Pair mode changes only the source selection/label, never the fixture or its expectations.
const supervisorPath = positional[1] ?? `${nativeRoot}/src/tools/browser/tab-supervisor.ts`;
const paths = [
  `${nativeRoot}/src/tools/browser/target-observation.ts`,
  `${nativeRoot}/src/tools/browser/cmux/surface-observation.ts`,
  supervisorPath,
];
const sources = await Promise.all(paths.map(path => readFile(path, "utf8")));
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
const transpiler = new Bun.Transpiler({ loader: "ts" });
function readerBody(source: string): string {
  const body = source.replace(/^import type[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
  assert(!/^import\b/m.test(body), "Reader must have no runtime imports");
  return transpiler.transformSync(body);
}
type Reader = { inspect(targetId: string): Promise<unknown>; assertCurrent(): void };
const captureRoot = new Function(`${readerBody(sources[0]!)}\nreturn captureBrowserTargetObservation;`)() as
  (browser: unknown, kind: string, timeout: number) => Promise<Reader>;
const captureCmux = new Function(`${readerBody(sources[1]!)}\nreturn captureCmuxSurfaceObservation;`)() as
  (client: unknown, timeout: number) => Reader;
const supervisor = sources[2]!;
function section(start: string, end: string): string {
  const a = supervisor.indexOf(start), b = supervisor.indexOf(end, a);
  assert(a >= 0 && b > a, `Missing exact supervisor section: ${start}`);
  return supervisor.slice(a, b);
}
const sections = [
  section("const tabs = new Map", "function markReportedInitFailure"),
  section("export function getTab(", "export async function runInTab("),
  section("export interface OwnerTabObservation", "/**\n * Captures the current viewport"),
];
const body = transpiler.transformSync(sections.join("\n").replaceAll("export ", ""));
type Result = { name: string; ownerSessionId: string; targetId: string; kindTag: string; presence: string };
type Root = { _closed: boolean; send(method: string, params: Record<string, unknown>, options: { timeout: number }): Promise<unknown> };
const surfaceId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const ticks = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
function harness(kind: string) {
  const targetId = kind === "cmux" ? surfaceId : kind === "relay" ? "PAGE7" : "target";
  const calls: Array<{ method: string; params: Record<string, unknown>; options: unknown }> = [];
  const counters = { captures: 0, holds: 0, releases: 0, releaseSettled: 0, replacementReads: 0 };
  let acquisitionHolds = 0, acquisitionReleases = 0;
  let present = true, captureUnavailable = false;
  let releaseGate: Promise<void> | undefined;
  const root: Root = { _closed: false, async send(method, params, options) {
    calls.push({ method, params, options });
    if (method === "OMP.getObservationContext") {
      if (captureUnavailable) throw new Error("Controlled relay capture unavailable");
      return { version: 1, connectionId: "original-extension" };
    }
    if (method === "OMP.inspectTab") return { connectionId: "original-extension", targetId: params.targetId, present };
    if (method === "Target.getTargets") return { targetInfos: present ? [{ targetId, type: "page" }] : [] };
    throw new Error(`Unexpected root command: ${method}`);
  } };
  const browser = { _connection: root, connected: true };
  const client = { connectionGeneration: 1 as number | undefined,
    async request(method: string, params: Record<string, unknown>, options?: unknown): Promise<Record<string, unknown>> {
      calls.push({ method, params, options });
      if (method === "browser.open_split") return { surface_id: surfaceId, url: "about:blank" };
      if (method === "surface.list") return { workspace_id: workspaceId, window_id: null, surfaces: [{ id: surfaceId, type: "browser" }] };
      throw new Error(`Unexpected cmux command: ${method}`);
    },
  };
  const handle = { kind: { kind }, refCount: 1, ...(kind === "cmux" ? { client } : { browser }) };
  const worker = { mode: "worker", onMessage(_fn: unknown) { return () => {}; }, async terminate() {} };
  class CmuxTab {
    async readyInfo() { return { targetId, url: "about:blank", title: "" }; }
    async goto() { throw new Error("Unexpected cmux navigation"); }
  }
  const api = new Function(
    "captureBrowserTargetObservation", "captureCmuxSurfaceObservation", "holdBrowser", "releaseBrowser",
    "buildInitPayload", "spawnTabWorker", "spawnInlineWorker", "initializeTabWorker", "closeAbandonedWorkerPage",
    "isReportedInitFailure", "initBudgetExhausted", "ToolError", "ToolAbortError", "BrowserTabCreateRejected",
    "getProjectDir", "runInTabWithSnapshot", "releaseTab", "CmuxTab", "mapWaitUntil", "DEFAULT_VIEWPORT",
    "logger", "handleTabMessage", "sharedScopeOf", "recordSharedTarget", "tabCleanups", "process",
    `${body}\nreturn { acquireTab, inspectTabForOwner, tabObservationReads };`,
  )(
    async (value: unknown, backend: string, timeout: number) => { counters.captures++; return await captureRoot(value, backend, timeout); },
    (value: unknown, timeout: number) => { counters.captures++; return captureCmux(value, timeout); },
    (value: typeof handle) => { counters.holds++; value.refCount++; },
    async (value: typeof handle) => { counters.releases++; await releaseGate; value.refCount--; counters.releaseSettled++; },
    async () => ({ mode: "headless" }), async () => worker,
    async () => { throw new Error("Unexpected inline fallback"); },
    async () => ({ targetId, url: "about:blank", title: "" }),
    () => { throw new Error("Unexpected abandoned worker"); }, () => false, () => false,
    Error, Error, Error, () => "/controlled", async () => {},
    async () => { throw new Error("Unexpected releaseTab"); }, CmuxTab, (value: unknown) => value, {},
    { warn() {} }, () => {}, () => undefined, async () => {}, new WeakMap(), { env: {} },
  ) as {
    acquireTab(name: string, value: typeof handle, options: object): Promise<{ created: boolean }>;
    inspectTabForOwner(owner: string, target: { name: string; targetId: string }): Promise<Result>;
    tabObservationReads: Map<unknown, Promise<void>>;
  };
  return {
    api, calls, counters, handle, root, browser, client, targetId,
    async create() {
      const holdsBefore = counters.holds, releasesBefore = counters.releases;
      const result = await api.acquireTab("tab", handle, { ownerSessionId: "owner", timeoutMs: 100 });
      acquisitionHolds += counters.holds - holdsBefore;
      acquisitionReleases += counters.releases - releasesBefore;
      return result;
    },
    read: () => api.inspectTabForOwner("owner", { name: "tab", targetId }),
    setPresence(value: boolean) { present = value; },
    holdRelease() { const gate = Promise.withResolvers<void>(); releaseGate = gate.promise; return gate; },
    failCapture() {
      if (kind === "cmux") client.connectionGeneration = undefined;
      else if (kind === "relay") captureUnavailable = true;
      else root._closed = true;
    },
    restoreCaptureState() { client.connectionGeneration = 1; root._closed = false; captureUnavailable = false; },
    replaceRoot() { browser._connection = { _closed: false, async send() { counters.replacementReads++; throw new Error("Replacement root must not be read"); } }; },
    assertBalanced(reads: number) {
      assert.equal(api.tabObservationReads.size, 0);
      assert.equal(handle.refCount, 2);
      assert.equal(acquisitionHolds - acquisitionReleases, 1, "Acquisition retains exactly the published tab hold");
      assert.equal(counters.holds, acquisitionHolds + reads);
      assert.equal(counters.releases, acquisitionReleases + reads);
      assert.equal(counters.releaseSettled, counters.releases);
      assert.equal(counters.captures, 1);
      assert.equal(counters.replacementReads, 0);
    },
  };
}
type Harness = ReturnType<typeof harness>;
type Outcome = { value: Result } | { error: unknown };
async function settle(h: Harness, mutate: () => void = () => {}) {
  const gate = h.holdRelease();
  const pending: Promise<Outcome> = h.read().then(value => ({ value }), error => ({ error }));
  let snapshot!: { releases: number; settled: number; pending: number; calls: number };
  try {
    await ticks();
    snapshot = { releases: h.counters.releases, settled: h.counters.releaseSettled, pending: h.api.tabObservationReads.size, calls: h.calls.length };
    mutate();
  } finally {
    // Never leave a controlled lease held because a fixture assertion failed.
    gate.resolve();
  }
  const outcome = await pending;
  assert.equal(snapshot.releases, snapshot.settled + 1, "Read must reach the held release before mutation");
  assert.equal(snapshot.pending, 1, "Read reservation must remain through lease settlement");
  assert.equal(h.calls.length, snapshot.calls, "Settlement must neither query nor recapture");
  return outcome;
}
const passed: string[] = [], failed: Array<{ name: string; error: string }> = [];
async function scenario(name: string, run: () => Promise<void>) {
  try { await run(); passed.push(name); }
  catch (error) { failed.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
function requireFailure(outcome: Outcome, pattern: RegExp) {
  assert("error" in outcome, `An invalidated original connection must reject the earlier result: ${JSON.stringify(outcome)}`);
  assert(outcome.error instanceof Error);
  assert.match(outcome.error.message, pattern);
}
function assertReadCalls(h: Harness, kind: string, reads: number) {
  const expected = kind === "cmux" ? ["browser.open_split", ...Array(reads).fill("surface.list")]
    : kind === "relay" ? ["OMP.getObservationContext", ...Array(reads).fill("OMP.inspectTab")]
    : Array(reads).fill("Target.getTargets");
  assert.deepEqual(h.calls.map(call => call.method), expected);
  for (const call of h.calls) {
    if (call.method === "surface.list") assert.deepEqual(call.options, { connectionGeneration: 1, checkedReply: true, timeoutMs: 100 });
    if (call.method === "Target.getTargets") assert.deepEqual(call.params, { filter: [{}] });
  }
}
for (const kind of ["headless", "spawned", "connected", "relay"]) {
  for (const presence of [true, false]) {
    for (const mutation of ["closed", "replacement", "disconnected"] as const) {
      await scenario(`${kind} ${presence ? "present" : "absent"}: original root ${mutation} during release rejects`, async () => {
        const h = harness(kind); await h.create(); h.setPresence(presence);
        const outcome = await settle(h, () => {
          if (mutation === "closed") h.root._closed = true;
          else if (mutation === "replacement") h.replaceRoot();
          else h.browser.connected = false;
        });
        requireFailure(outcome, /Original browser observation connection is unavailable/);
        assertReadCalls(h, kind, 1); h.assertBalanced(1);
      });
    }
  }
}
for (const generation of [2, undefined]) {
  await scenario(`cmux original generation becomes ${String(generation)} during release rejects presence`, async () => {
    const h = harness("cmux"); await h.create();
    const outcome = await settle(h, () => { h.client.connectionGeneration = generation; });
    requireFailure(outcome, /Original cmux observation connection is unavailable/);
    assertReadCalls(h, "cmux", 1); h.assertBalanced(1);
  });
}
for (const kind of ["headless", "spawned", "connected", "relay", "cmux"]) {
  await scenario(`${kind} repeated unchanged positive settlement uses one retained capture`, async () => {
    const h = harness(kind); await h.create();
    for (let i = 0; i < 2; i++) {
      const outcome = await settle(h);
      assert("value" in outcome);
      assert.deepEqual(outcome.value, { name: "tab", ownerSessionId: "owner", targetId: h.targetId, kindTag: kind, presence: "present" });
      assertReadCalls(h, kind, i + 1); h.assertBalanced(i + 1);
    }
  });
  if (kind !== "cmux") await scenario(`${kind} unchanged root absence settles without an extra query`, async () => {
    const h = harness(kind); await h.create(); h.setPresence(false);
    const outcome = await settle(h); assert("value" in outcome); assert.equal(outcome.value.presence, "absent");
    assertReadCalls(h, kind, 1); h.assertBalanced(1);
  });
  await scenario(`${kind} unavailable capture preserves history; cmux disconnected admission needs deliberate retry`, async () => {
    const h = harness(kind); h.failCapture();
    if (kind === "cmux") {
      await assert.rejects(h.create(), /original cmux tab connection/i);
      assert.equal(h.calls.length, 0); assert.equal(h.counters.holds, 0); assert.equal(h.counters.captures, 0);
      h.restoreCaptureState(); assert.equal((await h.create()).created, true);
      const result = await settle(h); assert("value" in result); assert.equal(result.value.presence, "present");
      h.assertBalanced(1); return;
    }
    assert.equal((await h.create()).created, true);
    h.restoreCaptureState(); const callsAfterCreate = h.calls.length;
    for (let i = 0; i < 2; i++) {
      const outcome = await settle(h);
      requireFailure(outcome, /Original (browser|cmux) observation connection is unavailable|Controlled relay capture unavailable/);
      assert.equal(h.calls.length, callsAfterCreate); h.assertBalanced(i + 1);
    }
    assert.equal((await h.create()).created, false);
    assert.equal(h.calls.length, callsAfterCreate); h.assertBalanced(2);
  });
}
console.log(JSON.stringify({
  pair: args.includes("--pair"),
  selections: paths.map((path, index) => ({ path, sha256: sha256(sources[index]!), bytes: Buffer.byteLength(sources[index]!) })),
  sections: sections.map(source => ({ sha256: sha256(source), bytes: Buffer.byteLength(source) })),
  passed, failed, counts: { passed: passed.length, failed: failed.length },
  limits: "Complete actual selected root and cmux readers plus exact selected supervisor sections; controlled root send, cmux requests, workers and held lease release. No SDK/native imports, real protocol/socket/browser/worker execution, or acquisition admission proof. Synchronous root assertion cannot detect relay extension-token replacement while the CDP root stays unchanged. Pair mode runs unchanged expectations with current readers and an optionally selected older supervisor.",
}, null, 2));
if (failed.length) process.exitCode = 1;
