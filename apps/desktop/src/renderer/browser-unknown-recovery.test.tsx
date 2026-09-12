import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserNewTabPanel as CurrentPanel } from "./BrowserNewTabPanel";
import { BrowserNewTabController, createBrowserNewTab } from "./browser-new-tab";
import type { BrowserCreateObservation, BrowserCreateReceipt, BrowserCreateRequest, BrowserFrameTarget, BrowserMetadataSnapshot, DesktopBridge } from "@agent-desktop/shared";
const Panel: typeof CurrentPanel = process.env.AGENT_DESKTOP_BROWSER_RECOVERY_PANEL
  ? (await import(process.env.AGENT_DESKTOP_BROWSER_RECOVERY_PANEL)).BrowserNewTabPanel : CurrentPanel;
const request: BrowserCreateRequest = { requestId: "recover-request", controlEpoch: "epoch", observedAt: 1_000_000, initialUrl: "https://example.invalid/start" };
const base = { protocolVersion: 1 as const, hostId: "owner", sessionId: "session", requestId: request.requestId };
const native = { name: `desktop-${request.requestId}`, targetId: "target", backend: "worker" as const, kindTag: "headless" as const,
  state: "alive" as const, url: request.initialUrl!, title: "Historical page", viewport: { width: 640, height: 480 } };
const receipt: BrowserCreateReceipt = { ...base, outcome: "completed", workerPid: 42, tab: native, targetDisposition: "created-page" };
const settled: BrowserCreateObservation = { ...base, status: "settled", receipt };
const live: BrowserMetadataSnapshot = { protocolVersion: 1, hostId: "owner", sessionId: "session", availability: "running", workerPid: 42,
  tabs: [{ ...native, title: "Current page", url: "https://example.invalid/later" }] };
function fixture(options: { observe?: () => Promise<unknown>; metadata?: () => Promise<unknown>; missing?: boolean } = {}) {
  const calls: Array<{ operation: string; session?: string; owner?: string; request?: BrowserCreateRequest }> = [];
  const replacements: Array<{ target: BrowserFrameTarget; title: string }> = [];
  const tab = { ...createBrowserNewTab("owner", "session", "instance"), browserNewTab: { status: "unknown" as const, draft: "original draft", request } };
  const bridge = { getBrowserCreationStatus: options.missing ? undefined : async (session: string, input: BrowserCreateRequest, owner?: string) => {
    calls.push({ operation: "status", session, owner, request: structuredClone(input) }); return options.observe ? options.observe() : settled;
  }, getBrowserMetadata: async (session: string, owner?: string) => {
    calls.push({ operation: "metadata", session, owner }); return options.metadata ? options.metadata() : live;
  }, createBrowserTab: async () => { calls.push({ operation: "create" }); throw new Error("Recovery must not create"); } } as unknown as DesktopBridge;
  const controller = new BrowserNewTabController(bridge, tab, () => {}, (target, title) => replacements.push({ target, title }), async () => {
    calls.push({ operation: "checkpoint" }); throw new Error("Recovery must not submit");
  });
  controller.connected = true;
  return { controller, calls, replacements };
}

test("explicit recovery checks original receipt then exact live target without creation or a new ticket", async () => {
  const f = fixture(); await f.controller.inspect();
  expect(f.calls).toEqual([{ operation: "status", session: "session", owner: "owner", request }, { operation: "metadata", session: "session", owner: "owner" }]);
  expect(f.replacements).toEqual([{ target: { workerPid: 42, name: native.name, targetId: native.targetId }, title: "Current page" }]);
  await f.controller.inspect(); await f.controller.submit(); expect(f.calls).toHaveLength(2);
});

test("pending, unavailable, unknown and definite rejection retain original draft and never acquire", async () => {
  for (const value of [{ ...base, status: "pending" }, { ...base, status: "unavailable" },
    { ...base, status: "settled", receipt: { ...base, outcome: "unknown", message: "Uncertain" } },
    { ...base, status: "settled", receipt: { ...base, outcome: "rejected", message: "Not acquired" } }]) {
    const f = fixture({ observe: async () => value }); await f.controller.inspect();
    expect(f.calls).toEqual([{ operation: "status", session: "session", owner: "owner", request }]);
    expect(f.replacements).toEqual([]); expect(f.controller.state.request).toEqual(request); expect(f.controller.state.draft).toBe("original draft");
    expect(f.controller.state.status).toBe(value.status === "settled" && "receipt" in value && value.receipt?.outcome === "rejected" ? "rejected" : "unknown");
    if (f.controller.state.status === "unknown") { await f.controller.submit(); f.controller.edit("replacement"); expect(f.calls).toHaveLength(1); expect(f.controller.state.draft).toBe("original draft"); }
    else { f.controller.edit("deliberate edit"); expect(f.controller.state).toEqual({ status: "idle", draft: "deliberate edit" }); }
    f.controller.dispose();
  }
});

test("historical completion is insufficient for absent, replaced, ambiguous or foreign live metadata", async () => {
  for (const value of [null, { ...live, protocolVersion: 2 }, { ...live, hostId: "foreign" }, { ...live, sessionId: "other" },
    { ...live, availability: "not-started", reason: "not running" }, { ...live, workerPid: 43 }, { ...live, tabs: [] },
    { ...live, tabs: [{ ...native, name: "other" }] }, { ...live, tabs: [{ ...native, targetId: "other" }] },
    { ...live, tabs: [native, native] }, { ...live, tabs: [{ ...native, state: "dead" }] },
    { ...live, tabs: [{ ...native, backend: "cmux", kindTag: "cmux" }] }, { ...live, tabs: [{ ...native, kindTag: "relay" }] }]) {
    const f = fixture({ metadata: async () => value }); await f.controller.inspect();
    expect(f.replacements).toEqual([]); expect(f.controller.state).toMatchObject({ status: "unknown", draft: "original draft", request });
    expect(f.calls.map(c => c.operation)).toEqual(["status", "metadata"]); f.controller.dispose();
  }
});

test("invalid observation/receipt and transport failures cannot become retry permission or fallback", async () => {
  for (const value of [null, { ...base, status: "other" }, { ...settled, hostId: "foreign" }, { ...settled, sessionId: "other" }, { ...settled, requestId: "other" },
    { ...base, status: "pending", receipt }, { ...settled, receipt: { ...receipt, requestId: "other" } },
    { ...settled, receipt: { ...receipt, workerPid: 0 } }, { ...settled, receipt: { ...receipt, targetDisposition: "adopted-existing-target" } },
    { ...settled, receipt: { ...receipt, tab: { ...native, name: "other" } } }, { ...settled, receipt: { ...base, outcome: "rejected", message: "" } }]) {
    const f = fixture({ observe: async () => value }); await f.controller.inspect(); expect(f.controller.state.status).toBe("unknown");
    expect(f.calls.map(c => c.operation)).toEqual(["status"]); expect(f.replacements).toEqual([]); f.controller.dispose();
  }
  const failed = fixture({ observe: async () => { throw new Error("controlled timeout"); } }); await failed.controller.inspect();
  expect(failed.controller.state.message).toBe("controlled timeout"); expect(failed.calls.map(c => c.operation)).toEqual(["status"]);
  const metadataFailure = fixture({ metadata: async () => { throw new Error("metadata timeout"); } }); await metadataFailure.controller.inspect();
  expect(metadataFailure.controller.state).toMatchObject({ status: "unknown", request, message: "metadata timeout" });
  expect(metadataFailure.calls.map(c => c.operation)).toEqual(["status", "metadata"]); expect(metadataFailure.replacements).toEqual([]);
  const missing = fixture({ missing: true }); await missing.controller.inspect(); expect(missing.calls).toEqual([]); expect(missing.controller.state.status).toBe("unknown");
  const offline = fixture(); offline.controller.connected = false; await offline.controller.inspect(); expect(offline.calls).toEqual([]);
});

test("concurrent checks share UI busy guard and close/disconnect across both awaits suppress late attachment", async () => {
  for (const phase of ["status", "metadata"]) for (const action of ["close", "disconnect"]) {
    const gate = Promise.withResolvers<unknown>(), started = Promise.withResolvers<void>();
    const f = fixture(phase === "status" ? { observe: () => { started.resolve(); return gate.promise; } } : { metadata: () => { started.resolve(); return gate.promise; } });
    const running = f.controller.inspect(); await started.promise;
    expect(f.controller.checking).toBe(true); await f.controller.inspect(); await f.controller.submit(); f.controller.edit("not applied");
    expect(f.calls.filter(c => c.operation === "status")).toHaveLength(1); expect(f.controller.state.draft).toBe("original draft");
    if (action === "close") f.controller.dispose(); else f.controller.connected = false;
    gate.resolve(phase === "status" ? settled : live); await running;
    expect(f.replacements).toEqual([]); expect(f.calls.some(c => c.operation === "create")).toBe(false); expect(f.controller.checking).toBe(false);
    if (phase === "status") expect(f.calls).toHaveLength(1);
  }
});

test("unknown launcher exposes explicit check and reflects inactive/offline/checking availability", () => {
  const f = fixture();
  const enabled = renderToStaticMarkup(<Panel controller={f.controller} active/>);
  expect(enabled).toContain('>Check creation status</button>');
  expect(enabled).not.toContain('disabled="">Check creation status');
  expect(enabled).toContain('readOnly=""');
  for (const mode of ["inactive", "offline", "checking"]) {
    f.controller.connected = mode !== "offline"; f.controller.checking = mode === "checking";
    const html = renderToStaticMarkup(<Panel controller={f.controller} active={mode !== "inactive"}/>);
    expect(html).toContain('disabled="">Check creation status');
  }
  f.controller.dispose();
});
