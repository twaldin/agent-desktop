import { testBrowserCreationRecords } from "./fixtures/browser-creation-journal";
import { expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserCreateRequest } from "@agent-desktop/shared";
import { requestBrowserCreate } from "../../desktop/src/main/browser-create-transport";
import { BrowserCreateHttp } from "./browser-create-http";

const tab = (name: string) => ({ name, targetId: "native-target", backend: "worker" as const, kindTag: "headless" as const,
  state: "alive" as const, url: "about:blank", title: "", viewport: { width: 640, height: 480 } });

function setup(create?: (name: string) => Promise<{ tab: ReturnType<typeof tab>; targetDisposition: "created-page" }>) {
  let now = 1_000_000;
  let calls = 0;
  let exists = true;
  const epoch = crypto.randomUUID();
  const handle = { workerPid: 42, createBrowserTab: async (name: string) => {
    calls++;
    return create ? create(name) : { tab: tab(name), targetDisposition: "created-page" as const };
  } };
  let current: typeof handle | undefined = handle;
  const http = new BrowserCreateHttp({ records: testBrowserCreationRecords(), hostId: "owner", controlEpoch: epoch, sessionExists: () => exists,
    getHandle: async () => handle, getExistingHandle: async () => current, now: () => now });
  const input: BrowserCreateRequest = { requestId: crypto.randomUUID(), controlEpoch: epoch, observedAt: now };
  const request = (value: unknown = input, owner = "owner") => new Request("http://localhost/v1/sessions/session/browser-create", {
    method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: owner }, body: JSON.stringify(value),
  });
  return { http, input, request, calls: () => calls, advance: (ms: number) => now += ms,
    replace: () => { current = undefined; }, remove: () => { exists = false; } };
}

test("browser creation rejects wrong owner, stale tickets and restart epochs before native admission", async () => {
  const s = setup();
  expect((await s.http.route(s.request(s.input, "other")))?.status).toBe(409);
  expect((await (await s.http.route(s.request({ ...s.input, controlEpoch: "old-epoch" })))!.json()).outcome).toBe("rejected");
  s.advance(60_001);
  expect((await (await s.http.route(s.request({ ...s.input, requestId: crypto.randomUUID() })))!.json()).outcome).toBe("rejected");
  expect(s.calls()).toBe(0);
});

test("concurrent duplicate creation shares one receipt and altered request identity is rejected", async () => {
  const gate = Promise.withResolvers<{ tab: ReturnType<typeof tab>; targetDisposition: "created-page" }>();
  const s = setup(async () => gate.promise);
  const first = s.http.route(s.request());
  const retry = s.http.route(s.request());
  await Bun.sleep(5);
  expect(s.calls()).toBe(1);
  gate.resolve({ tab: tab(`desktop-${s.input.requestId}`), targetDisposition: "created-page" });
  const [a, b] = await Promise.all([first, retry]);
  expect(await a!.json()).toEqual(await b!.json());
  expect((await (await s.http.route(s.request({ ...s.input, observedAt: s.input.observedAt + 1 })))!.json()).outcome).toBe("rejected");
  expect(s.calls()).toBe(1);
});

test("native preflight rejection stays rejected while dispatch and worker replacement are unknown", async () => {
  const rejected = setup(async () => { const error = new Error("disabled"); error.name = "BrowserTabCreateRejected"; throw error; });
  const a = await (await rejected.http.route(rejected.request()))!.json();
  expect(a.outcome).toBe("rejected");
  expect((await (await rejected.http.route(rejected.request()))!.json())).toEqual(a);
  expect(rejected.calls()).toBe(1);

  const uncertain = setup(async () => { throw new Error("acquisition failed"); });
  expect((await (await uncertain.http.route(uncertain.request()))!.json()).outcome).toBe("unknown");
  expect(uncertain.calls()).toBe(1);

  const gate = Promise.withResolvers<{ tab: ReturnType<typeof tab>; targetDisposition: "created-page" }>();
  const changed = setup(async () => gate.promise);
  const pending = changed.http.route(changed.request());
  await Bun.sleep(5); changed.replace();
  gate.resolve({ tab: tab(`desktop-${changed.input.requestId}`), targetDisposition: "created-page" });
  expect((await (await pending)!.json()).outcome).toBe("unknown");
  expect(changed.calls()).toBe(1);
});

test("production desktop transport submits once and validates the exact completed target", async () => {
  const s = setup();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    return (await s.http.route(request)) ?? new Response("", { status: 404 });
  } });
  try {
    const receipt = await requestBrowserCreate({ hostId: "owner", origin: server.url.origin, token: "fixture-token" }, "session", s.input);
    expect(receipt).toMatchObject({ outcome: "completed", workerPid: 42, targetDisposition: "created-page",
      tab: { name: `desktop-${s.input.requestId}`, targetId: "native-target" } });
    expect(s.calls()).toBe(1);
  } finally { await server.stop(true); }
});

test("production desktop transport returns only validated pre-admission HTTP failures as rejected", async () => {
  const input: BrowserCreateRequest = { requestId: crypto.randomUUID(), controlEpoch: crypto.randomUUID(), observedAt: Date.now() };
  const cases = [
    { status: 400, code: "INVALID_BROWSER_CREATE_REQUEST" },
    { status: 405, code: "INVALID_BROWSER_CREATE_REQUEST" },
    { status: 409, code: "OWNER_MISMATCH" },
  ] as const;
  for (const item of cases) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({
      error: { code: item.code, message: "Creation was rejected before native admission." },
    }, { status: item.status, headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }) });
    try {
      await expect(requestBrowserCreate({ hostId: "owner", origin: server.url.origin }, "session", input)).resolves.toMatchObject({
        protocolVersion: 1, hostId: "owner", sessionId: "session", requestId: input.requestId,
        outcome: "rejected", message: "Creation was rejected before native admission.",
      });
    } finally { await server.stop(true); }
  }

  for (const response of [
    Response.json({ error: { code: "OWNER_MISMATCH", message: "Wrong status." } }, { status: 400, headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }),
    Response.json({ error: { code: "UNKNOWN", message: "Unknown code." } }, { status: 409, headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }),
    Response.json({ error: { code: "INVALID_BROWSER_CREATE_REQUEST" } }, { status: 400, headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }),
    Response.json({ error: { code: "INVALID_BROWSER_CREATE_REQUEST", message: "Wrong owner." } }, { status: 400, headers: { [BROWSER_METADATA_OWNER_HEADER]: "other" } }),
  ]) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => response.clone() });
    try {
      await expect(requestBrowserCreate({ hostId: "owner", origin: server.url.origin }, "session", input)).rejects.toThrow("unknown");
    } finally { await server.stop(true); }
  }
});
