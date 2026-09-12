import { describe, expect, test } from "bun:test";
import { NativeBrowserOwner, type BrowserOwnerBackend, type BrowserOwnerOptions } from "./owner";

const options = { id: "draft-owner", cwd: "/admitted/project", agentDir: "/native/profile" };
const result = (name = "desktop-one") => ({ created: true as const, ownerSessionId: options.id, name,
  targetId: "actual-target", backend: "worker" as const, kindTag: "connected" as const,
  targetDisposition: "adopted-existing-target" as const, url: "https://example.invalid/observed", title: "Observed",
  viewport: { width: 640, height: 480 } });
const outcome = <T>(pending: Promise<T>) => pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(overrides: Partial<BrowserOwnerBackend> = {}) {
  const calls: string[] = [];
  const inputs: { signal: AbortSignal; request: { name: string; initialUrl?: string } }[] = [];
  const backend: BrowserOwnerBackend = {
    create: async (signal, request) => { calls.push("create"); inputs.push({ signal, request }); return result(request.name); },
    release: async () => { calls.push("release"); }, ...overrides,
  };
  let loaded: Readonly<BrowserOwnerOptions> | undefined;
  const input = { ...options };
  const owner = new NativeBrowserOwner(input, async value => { calls.push("load"); loaded = value; return backend; });
  return { owner, calls, inputs, input, get loaded() { return loaded; } };
}

describe("isolated native browser owner", () => {
  test("captures admitted options and returns bounded native metadata without session state", async () => {
    const h = fixture(); h.input.id = "changed"; h.input.cwd = "/different";
    await h.owner.ready();
    expect(h.loaded).toEqual(options); expect(h.owner.id).toBe(options.id); expect(h.owner.cwd).toBe(options.cwd);
    const value = await h.owner.createBrowserTab("desktop-one", "https://example.invalid/request");
    expect(value.tab).toEqual({ name: "desktop-one", targetId: "actual-target", backend: "worker", kindTag: "connected", state: "alive", url: "https://example.invalid/observed", title: "Observed", viewport: { width: 640, height: 480 } });
    expect(value.targetDisposition).toBe("adopted-existing-target");
    expect(h.inputs[0]?.request).toEqual({ name: "desktop-one", initialUrl: "https://example.invalid/request" });
    await h.owner.dispose(); await h.owner.dispose();
    expect(h.calls).toEqual(["load", "create", "release"]);
    expect(h.inputs[0]?.signal.aborted).toBe(true);
    expect(() => h.owner.createBrowserTab("desktop-two")).toThrow("retired");
  });

  test("retirement drains a sent acquisition before release and suppresses its result", async () => {
    const gate = Promise.withResolvers<ReturnType<typeof result>>();
    const events: string[] = []; let signal: AbortSignal | undefined;
    const h = fixture({ create: async value => { signal = value; events.push("create"); return gate.promise; }, release: async () => { events.push("release"); } });
    await h.owner.ready();
    const creating = h.owner.createBrowserTab("desktop-one");
    const rejected = outcome(creating); await tick();
    let done = false; const closing = h.owner.dispose().then(() => { done = true; });
    await tick(); expect(signal?.aborted).toBe(true); expect(done).toBe(false); expect(events).toEqual(["create"]);
    gate.resolve(result()); expect((await rejected).error?.message).toContain("retired"); await closing;
    expect(done).toBe(true); expect(events).toEqual(["create", "release"]);
  });

  test("close during settings/module initialization waits without admitting create", async () => {
    const setup = Promise.withResolvers<BrowserOwnerBackend>(); let creates = 0, releases = 0;
    const owner = new NativeBrowserOwner(options, () => setup.promise);
    const ready = outcome(owner.ready());
    const create = outcome(owner.createBrowserTab("desktop-one"));
    let done = false; const closing = owner.dispose().then(() => { done = true; });
    await tick(); expect(done).toBe(false);
    setup.resolve({ create: async () => { creates++; return result(); }, release: async () => { releases++; } });
    expect((await ready).error?.message).toContain("retired"); expect((await create).error?.message).toContain("retired"); await closing;
    expect(creates).toBe(0); expect(releases).toBe(1); expect(done).toBe(true);
  });

  test("loader failure remains initialization error and does not invent cleanup resources", async () => {
    const owner = new NativeBrowserOwner(options, async () => { throw new Error("Native API unavailable"); });
    await expect(owner.ready()).rejects.toThrow("Native API unavailable");
    await expect(owner.createBrowserTab("desktop-one")).rejects.toThrow("Native API unavailable");
    await owner.dispose(); await owner.dispose();
    expect(() => owner.createBrowserTab("desktop-two")).toThrow("retired");
  });

  test("late release failure remains visible on every disposal observer", async () => {
    let releases = 0;
    const h = fixture({ release: async () => { releases++; throw new Error("Native release failed"); } });
    await h.owner.ready(); await h.owner.createBrowserTab("desktop-one");
    for (const observation of [await outcome(h.owner.dispose()), await outcome(h.owner.dispose())]) {
      expect(observation.error).toBeInstanceOf(AggregateError);
      const error = observation.error as AggregateError;
      expect(error.message).toBe("Browser owner reservation cleanup failed");
      expect(error.errors.map(value => value instanceof Error ? value.message : String(value))).toContain("Native release failed");
    }
    expect(releases).toBe(1);
  });

  test("all in-flight acquisitions drain, including an operational failure", async () => {
    const first = Promise.withResolvers<ReturnType<typeof result>>(), second = Promise.withResolvers<ReturnType<typeof result>>();
    let releases = 0;
    const h = fixture({ create: async (_signal, request) => request.name === "desktop-one" ? first.promise : second.promise,
      release: async () => { releases++; } });
    await h.owner.ready();
    const one = outcome(h.owner.createBrowserTab("desktop-one"));
    const two = outcome(h.owner.createBrowserTab("desktop-two"));
    await tick(); const closing = h.owner.dispose();
    first.reject(new Error("Configured backend failed")); expect((await one).error?.message).toBe("Configured backend failed"); await tick(); expect(releases).toBe(0);
    second.resolve(result("desktop-two")); expect((await two).error?.message).toContain("retired"); await closing; expect(releases).toBe(1);
  });

  test("synchronous abort listener reentrancy cannot start a second release", async () => {
    let nested: Promise<void> | undefined, releases = 0;
    const h = fixture({ create: async signal => { signal.addEventListener("abort", () => { nested = h.owner.dispose(); }, { once: true }); return result(); },
      release: async () => { releases++; } });
    await h.owner.ready(); await h.owner.createBrowserTab("desktop-one");
    await h.owner.dispose(); await nested; expect(releases).toBe(1);
  });

  test("foreign or malformed sent results reject, with no fallback acquisition", async () => {
    for (const invalid of [{ ownerSessionId: "foreign" }, { name: "desktop-other" }, { targetId: "" }, { viewport: { width: 0, height: 1 } }, { targetDisposition: "invalid" }]) {
      let creates = 0, releases = 0;
      const h = fixture({ create: async () => { creates++; return { ...result(), ...invalid } as ReturnType<typeof result>; }, release: async () => { releases++; } });
      await h.owner.ready(); await expect(h.owner.createBrowserTab("desktop-one")).rejects.toThrow();
      expect(creates).toBe(1); await h.owner.dispose(); expect(releases).toBe(1);
    }
  });

  test("invalid owners fail before loader invocation", () => {
    let loads = 0; const load = async () => { loads++; throw new Error("must not load"); };
    for (const id of ["", "bad\0owner", "x".repeat(201)]) expect(() => new NativeBrowserOwner({ ...options, id }, load)).toThrow("identity");
    expect(() => new NativeBrowserOwner({ ...options, cwd: "" }, load)).toThrow("identity");
    expect(loads).toBe(0);
  });
});
