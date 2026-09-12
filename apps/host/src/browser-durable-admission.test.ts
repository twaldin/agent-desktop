import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserCreateRequest } from "@agent-desktop/shared";
import { HostStore } from "./store";
import { BrowserCreateHttp } from "./browser-create-http";

const RecreatedRoute: typeof BrowserCreateHttp = process.env.AGENT_DESKTOP_BROWSER_ADMISSION_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_BROWSER_ADMISSION_SOURCE)).BrowserCreateHttp : BrowserCreateHttp;
const input: BrowserCreateRequest = { requestId: "durable-request", controlEpoch: "durable-epoch", observedAt: 1_000_000,
  initialUrl: "https://example.invalid/exact?q=one%20two#kept" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "browser-admission-"));
  let store = new HostStore(root), now = input.observedAt;
  let calls = 0, handles = 0;
  const native = { workerPid: 42, createBrowserTab: async (name: string, initialUrl?: string) => {
    calls++; expect(initialUrl).toBe(input.initialUrl);
    return { tab: { name, targetId: "target", backend: "worker" as const, kindTag: "headless" as const,
      state: "alive" as const, url: initialUrl!, title: "Page", viewport: { width: 640, height: 480 } }, targetDisposition: "created-page" as const };
  } };
  const options = (epoch = input.controlEpoch) => ({ hostId: store.host.id, records: store.browserCreations, controlEpoch: epoch,
    sessionExists: () => true, getHandle: async () => { handles++; return native; }, getExistingHandle: async () => native, now: () => now });
  const request = (body: BrowserCreateRequest = input, operation = "open", owner = store.host.id) => new Request(`http://fixture.invalid/v1/sessions/session/browser-${operation}`, {
    method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: owner }, body: JSON.stringify(body),
  });
  return { root, native, options, request, get store() { return store; }, counts: () => ({ calls, handles }),
    advance: (ms: number) => { now += ms; }, reopen: () => { store.close(); store = new HostStore(root); },
    dispose: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function body(route: BrowserCreateHttp, request: Request) {
  const response = await route.route(request); expect(response).toBeDefined(); return response!.json();
}

test("durable route recreation returns original completion without repeating acquisition", async () => {
  const f = fixture();
  try {
    const current = new BrowserCreateHttp(f.options());
    const original = await body(current, f.request());
    expect(original.outcome).toBe("completed"); expect(f.counts()).toEqual({ calls: 1, handles: 1 });
    f.reopen();
    const recreated = new RecreatedRoute(f.options()); // Selected old route only here; first admission is current on both sides.
    expect(await body(recreated, f.request())).toEqual(original);
    expect(f.counts()).toEqual({ calls: 1, handles: 1 });
    f.advance(300_000);
    expect(await body(recreated, f.request())).toEqual(original);
    const restarted = new BrowserCreateHttp(f.options("new-epoch"));
    expect(await body(restarted, f.request())).toEqual(original);
    expect(await body(restarted, f.request(input, "creation-status"))).toMatchObject({ status: "settled", receipt: original });
    expect(f.counts()).toEqual({ calls: 1, handles: 1 });
  } finally { f.dispose(); }
});

test("pending journal without a local promise is unknown across epoch change and never dispatches", async () => {
  const f = fixture();
  try {
    f.store.browserCreations.claim("session", input); f.reopen();
    for (const epoch of [input.controlEpoch, "new-epoch"]) {
      const route = new BrowserCreateHttp(f.options(epoch));
      expect(await body(route, f.request())).toMatchObject({ outcome: "unknown", requestId: input.requestId });
      expect(await body(route, f.request(input, "creation-status"))).toMatchObject({ status: "settled", receipt: { outcome: "unknown" } });
    }
    expect(f.counts()).toEqual({ calls: 0, handles: 0 });
    expect(f.store.browserCreations.get("session", input)?.state).toBe("pending");
    const route = new BrowserCreateHttp(f.options());
    expect(await body(route, f.request({ ...input, initialUrl: "https://example.invalid/different" }))).toMatchObject({ outcome: "rejected" });
    const changed = await route.route(f.request({ ...input, observedAt: input.observedAt + 1 }, "creation-status"));
    expect(changed?.status).toBe(409); expect(f.counts()).toEqual({ calls: 0, handles: 0 });
  } finally { f.dispose(); }
});

test("admission write precedes acquisition; concurrent duplicate waits while observation is read-only", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const options = f.options(), originalAcquire = options.getHandle;
  const route = new BrowserCreateHttp({ ...options, getHandle: async () => {
    expect(f.store.browserCreations.get("session", input)?.state).toBe("pending");
    started.resolve(); await gate.promise; return originalAcquire();
  } });
  const first = route.route(f.request()); await started.promise;
  const duplicate = route.route(f.request());
  try {
    expect(await body(route, f.request(input, "creation-status"))).toMatchObject({ status: "pending" });
    expect(f.counts()).toEqual({ calls: 0, handles: 0 });
    gate.resolve();
    const result = await (await first)!.json(); expect(await (await duplicate)!.json()).toEqual(result);
    expect(f.counts()).toEqual({ calls: 1, handles: 1 }); expect(f.store.browserCreations.get("session", input)?.receipt).toEqual(result);
  } finally { gate.resolve(); await Promise.allSettled([first, duplicate]); f.dispose(); }
});

test("failed durable admission cannot acquire and failed durable settlement cannot report completion", async () => {
  for (const phase of ["INSERT", "UPDATE"]) {
    const f = fixture(), db = new Database(join(f.root, "state.sqlite"));
    try {
      db.exec(`CREATE TRIGGER fail_browser BEFORE ${phase} ON metadata WHEN NEW.key LIKE 'browser-creation.v1:%' BEGIN SELECT RAISE(ABORT,'controlled failure'); END`);
      const route = new BrowserCreateHttp(f.options());
      expect(await body(route, f.request())).toMatchObject({ outcome: "unknown" });
      expect(f.counts()).toEqual(phase === "INSERT" ? { calls: 0, handles: 0 } : { calls: 1, handles: 1 });
      if (phase === "UPDATE") {
        expect(f.store.browserCreations.get("session", input)?.state).toBe("pending");
        expect(await body(route, f.request(input, "creation-status"))).toMatchObject({ status: "settled", receipt: { outcome: "unknown" } });
        db.exec("DROP TRIGGER fail_browser"); f.reopen();
        expect(await body(new BrowserCreateHttp(f.options("next")), f.request())).toMatchObject({ outcome: "unknown" });
        expect(f.counts()).toEqual({ calls: 1, handles: 1 });
      }
    } finally { db.close(); f.dispose(); }
  }
});

test("corrupt journal and absent required journal fail closed without acquisition or silent fallback", async () => {
  const f = fixture();
  try {
    f.store.browserCreations.claim("session", input);
    f.store.writeMetadata('browser-creation.v1:["session","durable-request"]', { invalid: true });
    const route = new BrowserCreateHttp(f.options());
    expect(await body(route, f.request())).toMatchObject({ outcome: "unknown" });
    expect((await route.route(f.request(input, "creation-status")))?.status).toBe(503);
    const broken = new BrowserCreateHttp({ ...f.options(), records: undefined as never });
    expect(await body(broken, f.request())).toMatchObject({ outcome: "unknown" });
    expect(f.counts()).toEqual({ calls: 0, handles: 0 });
  } finally { f.dispose(); }
});
