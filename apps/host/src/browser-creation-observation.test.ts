import { testBrowserCreationRecords } from "./fixtures/browser-creation-journal";
import { expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserCreateRequest } from "@agent-desktop/shared";
import { BrowserCreateHttp as CurrentBrowserCreateHttp } from "./browser-create-http";
import { requestBrowserCreate, requestBrowserCreationStatus } from "../../desktop/src/main/browser-create-transport";

const BrowserCreateHttp: typeof CurrentBrowserCreateHttp = process.env.AGENT_DESKTOP_BROWSER_CREATE_SOURCE
  ? (await import(process.env.AGENT_DESKTOP_BROWSER_CREATE_SOURCE)).BrowserCreateHttp : CurrentBrowserCreateHttp;
const input: BrowserCreateRequest = { requestId: "observe-request", controlEpoch: "observe-epoch", observedAt: 1_000_000,
  initialUrl: "https://example.invalid/start?q=one%20two#kept" };
const native = { name: `desktop-${input.requestId}`, targetId: "target", state: "alive" as const,
  backend: "worker" as const, kindTag: "headless" as const, url: "https://example.invalid/redirect", title: "Page", viewport: { width: 640, height: 480 } };
function fixture(acquire?: () => Promise<void>) {
  let now = input.observedAt;
  const calls = { exists: 0, handle: 0, existing: 0, create: 0 };
  const started = Promise.withResolvers<void>();
  const handle = { workerPid: 42, createBrowserTab: async () => {
    calls.create++; started.resolve(); await acquire?.(); return { tab: native, targetDisposition: "created-page" as const };
  } };
  const options = { records: testBrowserCreationRecords(), hostId: "owner", controlEpoch: input.controlEpoch,
    sessionExists: () => { calls.exists++; return true; },
    getHandle: async () => { calls.handle++; return handle; },
    getExistingHandle: async () => { calls.existing++; return handle; }, now: () => now };
  const http = new BrowserCreateHttp(options);
  const request = (operation: string, body: unknown = input, owner = "owner", session = "session") =>
    new Request(`http://fixture.invalid/v1/sessions/${session}/browser-${operation}`, {
      method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: owner }, body: JSON.stringify(body),
    });
  const observe = async (body: unknown = input, owner = "owner", session = "session") => {
    const response = await http.route(request("creation-status", body, owner, session));
    expect(response).toBeDefined(); expect(response!.headers.get("cache-control")).toBe("no-store");
    return { status: response!.status, body: await response!.json() };
  };
  return { http, calls, options, request, observe, started, advance: (ms: number) => now += ms };
}

test("creation observation reports missing without admission and pending without waiting for native settlement", async () => {
  const gate = Promise.withResolvers<void>(), f = fixture(() => gate.promise);
  expect((await f.observe()).body).toMatchObject({ status: "unavailable", hostId: "owner", sessionId: "session", requestId: input.requestId });
  expect(f.calls).toEqual({ exists: 0, handle: 0, existing: 0, create: 0 });
  const creating = f.http.route(f.request("open"));
  await f.started.promise;
  try {
    const before = { ...f.calls };
    expect((await f.observe()).body.status).toBe("pending");
    f.advance(300_000); // An unresolved acquisition is retained beyond settled TTL.
    expect((await f.observe()).body.status).toBe("pending");
    expect(f.calls).toEqual(before);
  } finally { gate.resolve(); await creating; }
});

test("retained receipt observation fences exact input and retains durable history without replaying acquisition", async () => {
  const f = fixture();
  const receipt = await (await f.http.route(f.request("open")))!.json();
  const before = { ...f.calls };
  expect((await f.observe()).body).toMatchObject({ status: "settled", receipt });
  for (const changed of [{ ...input, initialUrl: "https://example.invalid/different" },
    { ...input, observedAt: input.observedAt + 1 }, { ...input, initialUrl: undefined }]) {
    const result = await f.observe(changed); expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("BROWSER_CREATE_INPUT_MISMATCH"); expect(result.body.receipt).toBeUndefined();
  }
  expect((await f.observe(input, "foreign")).status).toBe(409);
  expect((await f.observe(input, "owner", "another-session")).body.status).toBe("unavailable");
  expect((await f.observe({ ...input, controlEpoch: "older-host" })).status).toBe(409);
  f.advance(119_999); expect((await f.observe()).body.status).toBe("settled");
  f.advance(2); expect((await f.observe()).body.status).toBe("settled");
  expect((await f.observe()).body.status).toBe("settled"); expect(f.calls).toEqual(before);
});

test("creation observations preserve definite rejection and unknown and retain historical receipts across route restart", async () => {
  for (const rejected of [false, true]) {
    const f = fixture(async () => { const error = new Error("controlled acquisition failure"); if (rejected) error.name = "BrowserTabCreateRejected"; throw error; });
    const receipt = await (await f.http.route(f.request("open")))!.json();
    expect(receipt.outcome).toBe(rejected ? "rejected" : "unknown");
    const before = { ...f.calls };
    expect((await f.observe()).body).toMatchObject({ status: "settled", receipt });
    const restarted = new BrowserCreateHttp({ ...f.options, controlEpoch: "new-epoch" });
    const result = await (await restarted.route(f.request("creation-status")))!.json();
    expect(result.status).toBe("settled"); expect(result.receipt).toEqual(receipt); expect(f.calls).toEqual(before);
  }
});

test("missing observation cannot exhaust creation admission, and malformed input stays read-only", async () => {
  const f = fixture();
  for (let n = 0; n < 4097; n++) {
    const result = await f.http.route(f.request("creation-status", { ...input, requestId: `absent-${n}` }));
    if (!result || result.status !== 200 || (await result.json()).status !== "unavailable") throw new Error("Missing observation altered admission.");
  }
  for (const invalid of [null, { ...input, initialUrl: "file:///tmp/a" }, { ...input, requestId: "" }]) expect((await f.observe(invalid)).status).toBe(400);
  const method = await f.http.route(new Request("http://fixture.invalid/v1/sessions/session/browser-creation-status", { headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }));
  expect(method?.status).toBe(405); expect(f.calls).toEqual({ exists: 0, handle: 0, existing: 0, create: 0 });
  expect((await (await f.http.route(f.request("open")))!.json()).outcome).toBe("completed"); expect(f.calls.create).toBe(1);
});

test("observation transport uses authenticated exact body once with real route, without create fallback", async () => {
  const originalFetch = globalThis.fetch, f = fixture(); const calls: Request[] = [];
  const endpoint = { hostId: "owner", origin: "http://fixture.invalid", token: "fixture-only" };
  try {
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(url as string, init); calls.push(request.clone());
      expect(request.headers.get("authorization")).toBe("Bearer fixture-only");
      return (await f.http.route(request)) ?? new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    expect((await requestBrowserCreationStatus(endpoint, "session", input)).status).toBe("unavailable");
    expect(f.calls.create).toBe(0);
    const created = await requestBrowserCreate(endpoint, "session", input);
    expect(await requestBrowserCreationStatus(endpoint, "session", input)).toMatchObject({ status: "settled", receipt: created });
    expect(f.calls.create).toBe(1);
    expect(calls.map(r => new URL(r.url).pathname)).toEqual(["/v1/sessions/session/browser-creation-status", "/v1/sessions/session/browser-open", "/v1/sessions/session/browser-creation-status"]);
    expect(await calls[0]!.json()).toEqual(input); expect(new URL(calls[0]!.url).search).toBe("");
    calls.length = 0;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { calls.push(new Request(url as string, init)); return Response.json({}, { status: 404, headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }); }) as unknown as typeof fetch;
    await expect(requestBrowserCreationStatus(endpoint, "session", input)).rejects.toThrow("do not replay");
    expect(calls).toHaveLength(1); expect(new URL(calls[0]!.url).pathname).toEndWith("/browser-creation-status");
  } finally { globalThis.fetch = originalFetch; }
});

test("observation transport rejects malformed outer/nested owners and targets, without swallowing failures", async () => {
  const originalFetch = globalThis.fetch;
  const base = { protocolVersion: 1, hostId: "owner", sessionId: "session", requestId: input.requestId };
  const receipt = { ...base, outcome: "completed", workerPid: 42, tab: native, targetDisposition: "created-page" };
  const settled = { ...base, status: "settled", receipt };
  const malformed = [null, { ...base, status: "missing" }, { ...settled, hostId: "foreign" }, { ...settled, requestId: "other" },
    { ...settled, sessionId: "other" }, { ...settled, protocolVersion: 2 }, { ...settled, receipt: null },
    { ...settled, receipt: { ...receipt, hostId: "foreign" } }, { ...settled, receipt: { ...receipt, requestId: "other" } },
    { ...settled, receipt: { ...receipt, workerPid: 0 } }, { ...settled, receipt: { ...receipt, targetDisposition: "adopted-existing-target" } },
    { ...settled, receipt: { ...receipt, tab: { ...native, name: "other" } } },
    { ...base, status: "pending", receipt }, { ...base, status: "unavailable", receipt }];
  let calls = 0;
  try {
    for (const value of malformed) {
      globalThis.fetch = (async () => { calls++; return Response.json(value, { headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }); }) as unknown as typeof fetch;
      await expect(requestBrowserCreationStatus({ hostId: "owner", origin: "http://fixture.invalid" }, "session", input)).rejects.toThrow();
    }
    expect(calls).toBe(malformed.length);
    for (const status of [401, 409, 500]) {
      globalThis.fetch = (async () => Response.json({}, { status, headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
      await expect(requestBrowserCreationStatus({ hostId: "owner", origin: "http://fixture.invalid" }, "session", input)).rejects.toThrow("do not replay");
    }
    globalThis.fetch = (async () => { throw new Error("controlled timeout"); }) as unknown as typeof fetch;
    await expect(requestBrowserCreationStatus({ hostId: "owner", origin: "http://fixture.invalid" }, "session", input)).rejects.toThrow("controlled timeout");
    globalThis.fetch = (async () => Response.json(settled, { headers: { [BROWSER_METADATA_OWNER_HEADER]: "foreign" } })) as unknown as typeof fetch;
    await expect(requestBrowserCreationStatus({ hostId: "owner", origin: "http://fixture.invalid" }, "session", input)).rejects.toThrow("another host");
  } finally { globalThis.fetch = originalFetch; }
});
