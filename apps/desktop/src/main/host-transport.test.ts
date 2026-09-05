import { afterAll, expect, test } from "bun:test";
import { nativeTerminalResult, requestHost } from "./host-transport";

const requests: { method: string; authorized: boolean; body: unknown }[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/success") {
    requests.push({ method: request.method, authorized: request.headers.get("Authorization") === "Bearer test-only-transport-token", body: await request.json() });
    return Response.json({ accepted: true });
  }
  if (path === "/unsupported") return Response.json({ error: { code: "NATIVE_TERMINAL_UNSUPPORTED", message: "Native terminals unavailable." } }, { status: 404 });
  if (path === "/geometry") return Response.json({ code: "STALE_TERMINAL_GEOMETRY", error: "The grid changed." }, { status: 409 });
  if (path === "/unauthorized") return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (path === "/malformed") return new Response("Not a host response", { status: 404 });
  return Response.json({ error: "Not found" }, { status: 404 });
} });
const endpoint = { origin: `http://127.0.0.1:${server.port}`, hostId: "transport-test-host", token: "test-only-transport-token" };
afterAll(() => server.stop(true));

test("native request results preserve successful payloads without carrying endpoint credentials", async () => {
  const payload = { terminalId: "term", attachmentId: "viewer", sequence: 3, input: { kind: "paste", data: "λ\n" } };
  const result = await nativeTerminalResult(() => requestHost(endpoint, "/success", payload));
  expect(structuredClone(result)).toEqual({ ok: true, value: { accepted: true } });
  expect(requests.at(-1)).toEqual({ method: "POST", authorized: true, body: payload });
  expect(JSON.stringify(result)).not.toContain(endpoint.token);
});

test("native failures retain structured HTTP status and both host error formats", async () => {
  expect(structuredClone(await nativeTerminalResult(() => requestHost(endpoint, "/unsupported")))).toEqual({ ok: false,
    error: { message: "Native terminals unavailable.", status: 404, code: "NATIVE_TERMINAL_UNSUPPORTED" } });
  expect(await nativeTerminalResult(() => requestHost(endpoint, "/geometry"))).toEqual({ ok: false,
    error: { message: "The grid changed.", status: 409, code: "STALE_TERMINAL_GEOMETRY" } });
  expect(await nativeTerminalResult(() => requestHost(endpoint, "/missing"))).toEqual({ ok: false, error: { message: "Not found", status: 404 } });
});

test("authorization, malformed responses and connection failures cannot masquerade as unsupported", async () => {
  expect(await nativeTerminalResult(() => requestHost(endpoint, "/unauthorized"))).toEqual({ ok: false, error: { message: "Unauthorized", status: 401 } });
  const malformed = await nativeTerminalResult(() => requestHost(endpoint, "/malformed"));
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) { expect(malformed.error.status).toBeUndefined(); expect(malformed.error.code).toBeUndefined(); }
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const origin = `http://127.0.0.1:${closed.port}`; closed.stop(true);
  const disconnected = await nativeTerminalResult(() => requestHost({ ...endpoint, origin }, "/v2/terminals/capabilities"));
  expect(disconnected.ok).toBe(false);
  if (!disconnected.ok) { expect(disconnected.error.status).toBeUndefined(); expect(disconnected.error.code).toBeUndefined(); }
});
