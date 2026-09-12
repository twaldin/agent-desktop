import { afterEach, expect, test } from "bun:test";
import type { BrowserCreateRequest, DraftBrowserBridge, DraftBrowserCreationObservation, DraftBrowserCreationReceipt, DraftBrowserOwnerSnapshot, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { createDraftBrowserPageIntent, DraftBrowserPageController as CurrentDraftBrowserPageController, parseDraftBrowserPageIntent, type DraftBrowserPageIntent, type DraftBrowserPageReady } from "./draft-browser-page";
const DraftBrowserPageController: typeof CurrentDraftBrowserPageController = process.env.AGENT_DESKTOP_DRAFT_PAGE_CONTROLLER
  ? (await import(process.env.AGENT_DESKTOP_DRAFT_PAGE_CONTROLLER)).DraftBrowserPageController : CurrentDraftBrowserPageController;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const owner = { version: 1 as const, hostId: "host", reference: { ownerId: "original", draftId: "new-conversation", draftRevision: 3 } };
const request = (): BrowserCreateRequest => ({ requestId: "request", controlEpoch: "epoch", observedAt: 100, initialUrl: "https://example.com/" });
const restored = (): DraftBrowserPageIntent => ({ ...createDraftBrowserPageIntent(owner, "page-one"), launcher: { status: "unknown", draft: "example.com", request: request() } });
type Phase = "status" | "checkpoint" | "create" | "observation" | "metadata" | "publication";
function fixture(options: { restored?: DraftBrowserPageIntent; holds?: Partial<Record<Phase, Promise<void>>>; createFails?: boolean; checkpointFails?: boolean; refusePublication?: boolean } = {}) {
  let last = structuredClone(options.restored?.launcher.request ?? request()), ownerGeneration = 0;
  let outcome: DraftBrowserCreationReceipt["outcome"] = "completed", history: "pending" | "unavailable" | "settled" = "settled";
  let workerPid = 50, currentPid = 50, duplicate = false, absent = false, backendChanged = false;
  let statusAvailable = true, foreignObservation = false;
  let statusResult: DraftBrowserOwnerSnapshot | undefined;
  const events: { phase: Phase; reference?: unknown; hostId?: string; request?: BrowserCreateRequest }[] = [];
  const changes: DraftBrowserPageIntent[] = [], checkpoints: DraftBrowserPageIntent[] = [], ready: DraftBrowserPageReady[] = [], publicationGuards: boolean[] = [];
  const native = (): NativeBrowserTabMetadata => ({ name: `desktop-${last.requestId}`, targetId: "native-target", backend: "worker", kindTag: "headless", state: "alive", url: last.initialUrl!, title: "Example", viewport: { width: 400, height: 900 } });
  const receipt = (): DraftBrowserCreationReceipt => {
    const base = { protocolVersion: 1 as const, ownerKind: "draft" as const, hostId: "host", ownerId: "original", requestId: last.requestId };
    return outcome === "completed" ? { ...base, outcome, workerPid, tab: native(), targetDisposition: "created-page" }
      : { ...base, outcome, message: `Known ${outcome}` };
  };
  const record = async (phase: Phase, reference?: unknown, hostId?: string, query?: BrowserCreateRequest) => {
    events.push({ phase, ...(reference === undefined ? {} : { reference: structuredClone(reference), hostId }), ...(query ? { request: structuredClone(query) } : {}) }); await options.holds?.[phase];
  };
  const bridge: Pick<DraftBrowserBridge, "status" | "create" | "creationStatus" | "metadata"> = {
    status: async (ref, hostId) => { await record("status", ref, hostId); return statusResult = { protocolVersion: 1, hostId, ownerId: ref.ownerId, state: statusAvailable ? "ready" : "unavailable", workerPid: 50, ticket: { controlEpoch: "epoch", observedAt: 100 } }; },
    create: async (ref, input, hostId) => { last = structuredClone(input); await record("create", ref, hostId, input); if (options.createFails) throw new Error("Response lost"); return receipt(); },
    creationStatus: async (ref, input, hostId): Promise<DraftBrowserCreationObservation> => {
      last = structuredClone(input); await record("observation", ref, hostId, input);
      const base = { protocolVersion: 1 as const, ownerKind: "draft" as const, hostId: foreignObservation ? "foreign" : hostId, ownerId: ref.ownerId, requestId: input.requestId };
      return history === "settled" ? { ...base, status: "settled", receipt: receipt() } : { ...base, status: history };
    },
    metadata: async (ref, hostId) => { await record("metadata", ref, hostId); const tab = native(); if (backendChanged) tab.kindTag = "connected";
      return { protocolVersion: 1, ownerKind: "draft", hostId, ownerId: ref.ownerId, availability: "running", workerPid: currentPid, tabs: absent ? [] : duplicate ? [tab, structuredClone(tab)] : [tab] }; },
  };
  const controller = new DraftBrowserPageController(bridge, options.restored ?? createDraftBrowserPageIntent(owner, "page-one"), value => { changes.push(structuredClone(value)); },
    async (value, signal) => {
      checkpoints.push(structuredClone(value));
      const wait = record("checkpoint");
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Checkpoint cancelled")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        void wait.then(() => { signal.removeEventListener("abort", abort); resolve(); }, reject);
      });
      if (options.checkpointFails) throw new Error("Window acknowledgement failed");
    }, selected => {
      if (JSON.stringify(selected) !== JSON.stringify(owner)) throw new Error("Wrong original owner");
      const generation = ownerGeneration; return () => generation === ownerGeneration;
    }, async (result, guard) => {
      await record("publication"); const allowed = guard(); publicationGuards.push(allowed);
      if (!allowed || options.refusePublication) return false; ready.push(structuredClone(result)); return true;
    });
  controller.observe({ connected: true, enabled: true }); cleanup.push(() => controller.dispose());
  return { controller, events, changes, checkpoints, ready, publicationGuards, bridge,
    outcome: (value: typeof outcome) => { outcome = value; }, history: (value: typeof history) => { history = value; },
    statusUnavailable: () => { statusAvailable = false; }, foreignObservation: () => { foreignObservation = true; },
    mutateStatusPid: () => { if (!statusResult) throw new Error("No status response yet"); statusResult.workerPid = 51; },
    swapPid: () => { workerPid = currentPid = 51; }, wrongCurrentPid: () => { currentPid = 51; }, noTarget: () => { absent = true; },
    duplicate: () => { duplicate = true; }, backendChanged: () => { backendChanged = true; }, ownerLoss: () => { ownerGeneration++; } };
}

test("draft page construction and explicit empty edits remain local with exact captured owner identity", async () => {
  const input = createDraftBrowserPageIntent(owner, "page-one"), f = fixture({ restored: input }); input.owner.reference.draftId = "foreign";
  f.controller.edit(""); await f.controller.submit(); expect(f.events).toEqual([]); expect(f.controller.state).toEqual({ status: "idle", draft: "" });
  const copy = f.controller.intent; copy.owner.reference.ownerId = "wrong"; expect(f.controller.intent.owner).toEqual(owner);
  expect(() => parseDraftBrowserPageIntent({ ...input, sessionId: "fake-session" })).toThrow("Invalid draft browser page intent");
  expect(() => parseDraftBrowserPageIntent({ ...input, instanceId: "bad:id" })).toThrow("identity");
});

test("initial URL creation waits for exact full page checkpoint and publishes only the verified original target", async () => {
  const held = gate(), f = fixture({ holds: { checkpoint: held.promise } }); f.controller.edit("localhost:3000/path?q=one");
  const pending = f.controller.submit(); await tick();
  const saved = f.checkpoints[0]!; expect(saved.owner).toEqual(owner); expect(saved.instanceId).toBe("page-one");
  expect(saved.launcher).toMatchObject({ status: "pending", draft: "localhost:3000/path?q=one", request: { initialUrl: "http://localhost:3000/path?q=one", controlEpoch: "epoch", observedAt: 100 } });
  expect(f.events.map(x => x.phase)).toEqual(["status", "checkpoint"]); held.resolve(); await pending;
  expect(f.events.map(x => x.phase)).toEqual(["status", "checkpoint", "create", "metadata", "publication"]);
  expect(f.events[2]?.request).toEqual(saved.launcher.request); expect(f.ready[0]?.intent).toEqual(saved); expect(f.ready[0]?.workerPid).toBe(50);
  expect(f.publicationGuards).toEqual([true]); await f.controller.submit(); expect(f.events).toHaveLength(5);
});

test("invalid address, unavailable owner and failed window acknowledgement never create", async () => {
  for (const mode of ["address", "owner", "checkpoint"] as const) {
    const f = fixture({ checkpointFails: mode === "checkpoint" }); if (mode === "owner") f.statusUnavailable();
    f.controller.edit(mode === "address" ? "/private/file" : "example.com"); await f.controller.submit();
    expect(f.controller.state.status).toBe("rejected"); expect(f.events.some(value => value.phase === "create")).toBe(false); expect(f.ready).toEqual([]);
  }
});

test("lost response retains exact request and URL, blocks repeated Enter and recovers through journal only", async () => {
  const f = fixture({ createFails: true }); f.controller.edit("example.com"); await f.controller.submit(); const original = f.controller.intent;
  expect(original.launcher.status).toBe("unknown"); f.controller.edit("other.example"); await f.controller.submit(); expect(f.controller.intent).toEqual(original);
  await f.controller.inspect(); expect(f.events.map(x => x.phase)).toEqual(["status", "checkpoint", "create", "observation", "metadata", "publication"]);
  expect(f.events[3]?.request).toEqual(original.launcher.request); expect(f.ready[0]?.intent.owner).toEqual(owner);
  expect(f.events.filter(x => x.phase === "create")).toHaveLength(1);
});

test("restored pending is inspect-only and unavailable or pending history never acquires or creates", async () => {
  for (const history of ["pending", "unavailable"] as const) {
    const stored = restored(); stored.launcher.status = "pending"; const f = fixture({ restored: stored }); f.history(history);
    expect(f.events).toEqual([]); expect(f.controller.state.status).toBe("unknown"); await f.controller.submit(); await f.controller.inspect();
    expect(f.events.map(x => x.phase)).toEqual(["observation"]); expect(f.controller.state).toMatchObject({ status: "unknown", draft: "example.com", request: request() });
  }
});

test("confirmed negative history permits a fresh deliberate request but stale negative delivery never unlocks", async () => {
  const f = fixture({ restored: restored() }); f.outcome("rejected"); await f.controller.inspect(); expect(f.controller.state.status).toBe("rejected");
  f.controller.edit("localhost:4000"); f.outcome("completed"); await f.controller.submit();
  const sent = f.events.find(x => x.phase === "create")?.request; expect(sent?.requestId).not.toBe("request"); expect(sent?.initialUrl).toBe("http://localhost:4000");
  const held = gate(), stale = fixture({ restored: restored(), holds: { observation: held.promise } }); stale.outcome("rejected");
  const pending = stale.controller.inspect(); await tick(); stale.controller.observe({ connected: false, enabled: true }); stale.controller.observe({ connected: true, enabled: true }); held.resolve(); await pending;
  expect(stale.controller.state.status).toBe("unknown"); expect(stale.controller.state.request).toEqual(request()); expect(stale.events).toHaveLength(1);
});

test("loss and return at every creation await suppresses publication and does not repeat sent work", async () => {
  for (const phase of ["status", "checkpoint", "create", "metadata", "publication"] as const) {
    const held = gate(), f = fixture({ holds: { [phase]: held.promise } }); f.controller.edit("example.com"); const pending = f.controller.submit(); await tick();
    f.controller.observe({ connected: false, enabled: true }); f.controller.observe({ connected: true, enabled: true }); held.resolve(); await pending;
    expect(f.ready).toEqual([]); expect(f.controller.state.status).toBe(["status", "checkpoint"].includes(phase) ? "rejected" : "unknown");
    expect(f.events.filter(x => x.phase === "create")).toHaveLength(["status", "checkpoint"].includes(phase) ? 0 : 1);
    if (phase === "publication") expect(f.publicationGuards).toEqual([false]);
  }
});

test("lookup and queued recovery guards latch connection, action and original owner loss", async () => {
  for (const phase of ["observation", "metadata", "publication"] as const) for (const loss of ["connection", "action", "owner"] as const) {
    const held = gate(), f = fixture({ restored: restored(), holds: { [phase]: held.promise } }), pending = f.controller.inspect(); await tick();
    if (loss === "owner") f.ownerLoss(); else { f.controller.observe({ connected: loss !== "connection", enabled: loss !== "action" }); f.controller.observe({ connected: true, enabled: true }); }
    held.resolve(); await pending;
    expect(f.ready).toEqual([]); expect(f.controller.state).toMatchObject({ status: "unknown", request: request() }); expect(f.events.some(x => x.phase === "create")).toBe(false);
  }
});

test("current worker and native target must exactly match history, without URL or name fallback", async () => {
  for (const mismatch of ["wrongCurrentPid", "noTarget", "duplicate", "backendChanged", "foreignObservation"] as const) {
    const f = fixture({ restored: restored() }); f[mismatch](); await f.controller.inspect();
    expect(f.ready).toEqual([]); expect(f.controller.state.status).toBe("unknown"); expect(f.controller.state.request).toEqual(request());
  }
  const f = fixture(); f.controller.edit("example.com"); f.swapPid(); await f.controller.submit(); expect(f.controller.state.status).toBe("unknown"); expect(f.ready).toEqual([]);
});

test("refused queued replacement retains the created request instead of closing or reacquiring", async () => {
  const f = fixture({ refusePublication: true }); f.controller.edit("example.com"); await f.controller.submit(); const original = f.controller.intent;
  expect(original.launcher.status).toBe("unknown"); expect(f.ready).toEqual([]); await f.controller.submit(); expect(f.controller.intent).toEqual(original);
  expect(f.events.filter(x => x.phase === "create")).toHaveLength(1);
});

test("dispose before checkpoint cancels unsent work and after dispatch preserves original recovery intent", async () => {
  for (const phase of ["checkpoint", "create", "publication"] as const) {
    const held = gate(), f = fixture({ holds: { [phase]: held.promise } }); f.controller.edit("example.com"); const pending = f.controller.submit(); await tick();
    const saved = f.controller.intent; f.controller.dispose(); const changeCount = f.changes.length; held.resolve(); await pending;
    expect(f.changes).toHaveLength(changeCount); expect(f.controller.intent).toEqual(saved); expect(f.ready).toEqual([]);
    expect(f.events.filter(x => x.phase === "create")).toHaveLength(phase === "checkpoint" ? 0 : 1);
    expect(parseDraftBrowserPageIntent(saved).launcher.status).toBe("unknown");
  }
});

test("a stable observed context remains eligible and snapshot getters cannot mutate the sent binding", async () => {
  const held = gate(), f = fixture({ holds: { checkpoint: held.promise } }); f.controller.edit("example.com"); const pending = f.controller.submit(); await tick();
  const copy = f.controller.intent; copy.owner.reference.draftRevision = 999; copy.launcher.request!.initialUrl = "https://wrong.invalid";
  f.controller.observe({ connected: true, enabled: true }); held.resolve(); await pending;
  expect(f.ready).toHaveLength(1); expect(f.events.find(x => x.phase === "create")).toMatchObject({ reference: owner.reference, request: { initialUrl: "https://example.com" } });
});


test("the status worker identity is captured before creation awaits instead of rereading a mutable response", async () => {
  const held = gate(), f = fixture({ holds: { create: held.promise } }); f.controller.edit("example.com");
  const pending = f.controller.submit(); await tick(); f.swapPid(); f.mutateStatusPid(); held.resolve(); await pending;
  expect(f.ready).toEqual([]); expect(f.controller.state.status).toBe("unknown");
  expect(f.events.map(x => x.phase)).toEqual(["status", "checkpoint", "create"]);
  expect(f.controller.state.request?.initialUrl).toBe("https://example.com");
});
