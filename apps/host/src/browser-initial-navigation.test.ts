import { testBrowserCreationRecords } from "./fixtures/browser-creation-journal";
import { expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, parseBrowserCreateRequest, parseBrowserHumanAction } from "@agent-desktop/shared";
import { requestBrowserCreate } from "../../desktop/src/main/browser-create-transport";
import { BrowserCreateHttp } from "./browser-create-http";

const address = "https://example.invalid/start?q=one%20two#section";
const ticket = { requestId: "request-1", controlEpoch: "epoch-1", observedAt: 1_000_000 };
const tab = (name: string) => ({ name, targetId: "target-1", backend: "worker" as const, kindTag: "relay" as const,
  state: "alive" as const, url: "https://example.invalid/redirected", title: "Result", viewport: { width: 640, height: 480 } });
function fixture(acquire?: () => Promise<void>) {
  const calls: Array<{ name: string; initialUrl?: string }> = [];
  const handle = { workerPid: 42, createBrowserTab: async (name: string, initialUrl?: string) => {
    calls.push({ name, initialUrl });
    await acquire?.();
    return { tab: tab(name), targetDisposition: "adopted-existing-target" as const };
  } };
  let current: typeof handle | undefined = handle;
  const http = new BrowserCreateHttp({ records: testBrowserCreationRecords(), hostId: "owner", controlEpoch: ticket.controlEpoch, sessionExists: () => true,
    getHandle: async () => handle, getExistingHandle: async () => current, now: () => ticket.observedAt });
  const request = (body: unknown, operation = "open", owner = "owner") => new Request(`http://fixture.invalid/v1/sessions/session/browser-${operation}`, {
    method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: owner }, body: JSON.stringify(body),
  });
  return { http, request, calls, replace: () => { current = undefined; } };
}
const body = async (response: Response | undefined) => { expect(response).toBeDefined(); return response!.json(); };

test("initial navigation uses the existing observed-navigation address policy without normalization", () => {
  const context = { documentId: "doc", width: 640, height: 480, scrollX: 0, scrollY: 0 };
  for (const url of [address, "http://127.0.0.1:8080/", "about:blank", "https://example.invalid/%00"]) {
    expect(parseBrowserCreateRequest({ ...ticket, initialUrl: url }).initialUrl).toBe(url);
    expect(parseBrowserHumanAction({ type: "navigate", url }, context)).toEqual({ type: "navigate", url });
  }
  for (const url of [null, 5, "", "not a url", "https://example.invalid/a b", "https://example.invalid/\n", "file:///tmp/x", "javascript:alert(1)", "data:text/html,hello", "about:blank#used", `https://example.invalid/${"x".repeat(8192)}`]) {
    expect(() => parseBrowserCreateRequest({ ...ticket, initialUrl: url })).toThrow();
    expect(() => parseBrowserHumanAction({ type: "navigate", url }, context)).toThrow();
  }
  expect(parseBrowserCreateRequest(ticket)).toEqual(ticket);
});

test("open/create intent and invalid owner/address reject before native acquisition", async () => {
  const f = fixture();
  for (const [input, operation] of [[ticket, "open"], [{ ...ticket, initialUrl: address }, "create"], [{ ...ticket, initialUrl: "file:///tmp/x" }, "open"]] as const) {
    expect((await f.http.route(f.request(input, operation)))?.status).toBe(400);
  }
  expect((await f.http.route(f.request({ ...ticket, initialUrl: address }, "open", "other")))?.status).toBe(409);
  expect(f.calls).toEqual([]);
});

test("concurrent identical initial navigations share acquisition; changed URL and blank creation do not replay", async () => {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const f = fixture(async () => { started.resolve(); await gate.promise; });
  const input = { ...ticket, initialUrl: address };
  const first = f.http.route(f.request(input));
  const duplicate = f.http.route(f.request(input));
  await started.promise;
  expect(f.calls).toEqual([{ name: "desktop-request-1", initialUrl: address }]);
  expect((await body(await f.http.route(f.request({ ...input, initialUrl: "https://example.invalid/other" })))).outcome).toBe("rejected");
  expect((await body(await f.http.route(f.request(ticket, "create")))).outcome).toBe("rejected");
  gate.resolve();
  const result = await body(await first);
  expect(await body(await duplicate)).toEqual(result);
  expect(result).toMatchObject({ outcome: "completed", targetDisposition: "adopted-existing-target", workerPid: 42,
    tab: { url: "https://example.invalid/redirected", kindTag: "relay" } });
  expect(f.calls).toHaveLength(1);
});

test("failed acquisition and replaced worker retain unknown receipt without repeating navigation", async () => {
  const f = fixture(async () => { throw new Error("Navigation may have committed before disconnect"); });
  const input = { ...ticket, initialUrl: address };
  const result = await body(await f.http.route(f.request(input)));
  expect(result.outcome).toBe("unknown");
  expect(await body(await f.http.route(f.request(input)))).toEqual(result);
  expect(f.calls).toHaveLength(1);
  const replaced = fixture(async () => { replaced.replace(); });
  expect((await body(await replaced.http.route(replaced.request(input)))).outcome).toBe("unknown");
  expect(replaced.calls).toHaveLength(1);
  const unavailable = fixture(async () => { const error = new Error("Unsupported native capability"); error.name = "BrowserTabCreateRejected"; throw error; });
  expect((await body(await unavailable.http.route(unavailable.request(input)))).outcome).toBe("rejected");
});

test("desktop transport routes the URL once through real admission and never falls back on old-host 404", async () => {
  const originalFetch = globalThis.fetch;
  const f = fixture();
  const paths: string[] = [];
  try {
    globalThis.fetch = (async (url, init) => {
      const request = new Request(url as string, init); paths.push(new URL(request.url).pathname);
      expect(request.headers.get("authorization")).toBe("Bearer fixture-only");
      return (await f.http.route(request)) ?? new Response("Not found", { status: 404 });
    }) as typeof fetch;
    const receipt = await requestBrowserCreate({ hostId: "owner", origin: "http://fixture.invalid", token: "fixture-only" }, "session", { ...ticket, initialUrl: address });
    expect(receipt).toMatchObject({ outcome: "completed", targetDisposition: "adopted-existing-target" });
    expect(paths).toEqual(["/v1/sessions/session/browser-open"]);
    expect(f.calls).toEqual([{ name: "desktop-request-1", initialUrl: address }]);
    paths.length = 0;
    globalThis.fetch = (async url => {
      paths.push(new URL(url as string).pathname);
      return Response.json({ error: { code: "NOT_FOUND", message: "Old host" } }, { status: 404, headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } });
    }) as typeof fetch;
    await expect(requestBrowserCreate({ hostId: "owner", origin: "http://fixture.invalid" }, "session", { ...ticket, initialUrl: address })).rejects.toThrow("unknown");
    expect(paths).toEqual(["/v1/sessions/session/browser-open"]);
    paths.length = 0;
    await expect(requestBrowserCreate({ hostId: "owner", origin: "http://fixture.invalid" }, "session", ticket)).rejects.toThrow("unknown");
    expect(paths).toEqual(["/v1/sessions/session/browser-create"]);
  } finally { globalThis.fetch = originalFetch; }
});
