import { afterAll, expect, test } from "bun:test";
import { requestComposerCatalog } from "./composer-transport";
import type { OmpComposerCatalog } from "@agent-desktop/shared";

// Real HTTP transport against controlled route responses; no provider or live host.
const requests: Array<{ path: string; body: unknown; authorized: boolean }> = [];
let mode: number | "malformed" | "coded404" = 404;
let capabilitiesStatus = 200;
const native: OmpComposerCatalog = { cwd: "/fixture/project", models: [], default: { model: null, source: "unavailable" }, resolution: "native-registry-preview" };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push({ path, body: await request.json(), authorized: request.headers.get("Authorization") === "Bearer contract-transport-secret" });
  if (path === "/v1/models/composer") {
    if (mode === 200) return Response.json(native);
    if (mode === "malformed") return new Response("Not JSON", { status: 404 });
    return Response.json({ error: "Contract route failure", ...(mode === "coded404" ? { code: "MISSING_TARGET" } : {}) }, { status: mode === "coded404" ? 404 : mode });
  }
  if (capabilitiesStatus !== 200) return Response.json({ error: "Capabilities unavailable" }, { status: capabilitiesStatus });
  return Response.json([{ provider: "contract", id: "model", name: "Contract model", reasoning: true, input: ["text"],
    contextWindow: 100, maxTokens: 50, thinkingSelectors: ["auto", "off", "low"], thinking: { defaultLevel: "auto" }, headers: { authorization: "concealed-contract-field" } }]);
} });
const endpoint = { origin: `http://127.0.0.1:${server.port}`, hostId: "owner", token: "contract-transport-secret" };
afterAll(() => server.stop(true));

test("new native catalog passes through without a second query", async () => {
  mode = 200; requests.length = 0;
  expect(await requestComposerCatalog(endpoint, { projectId: "project" }, true)).toEqual(native);
  expect(requests).toHaveLength(1);
});

test("older-host route 404 uses only the same target-scoped capability path and labels unknown defaults and availability", async () => {
  mode = 404; capabilitiesStatus = 200; requests.length = 0;
  const result = await requestComposerCatalog(endpoint, { sessionId: "session" }, true);
  expect(requests).toEqual([
    { path: "/v1/models/composer", body: { target: { sessionId: "session" }, refresh: true }, authorized: true },
    { path: "/v1/models/capabilities", body: { target: { sessionId: "session" }, refresh: true }, authorized: true },
  ]);
  expect(structuredClone(result)).toMatchObject({ cwd: null, resolution: "legacy-capabilities", default: { model: null, source: "unknown-older-host" }, models: [{ id: "model", thinkingLevels: ["auto", "off", "low"] }] });
  expect(result.models[0]!.authenticated).toBeUndefined(); expect(result.models[0]!.available).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("secret"); expect(JSON.stringify(result)).not.toContain("concealed");
});

test("authentication, malformed, server and unrelated coded errors never invoke compatibility", async () => {
  for (const failure of [401, 403, 400, 500, 503, "malformed", "coded404"] as const) {
    mode = failure; requests.length = 0;
    await expect(requestComposerCatalog(endpoint, { projectId: "project" })).rejects.toThrow();
    expect(requests.map(request => request.path)).toEqual(["/v1/models/composer"]);
  }
  mode = 404; capabilitiesStatus = 500; requests.length = 0;
  await expect(requestComposerCatalog(endpoint)).rejects.toThrow("Capabilities unavailable");
  expect(requests).toHaveLength(2);
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const origin = `http://127.0.0.1:${closed.port}`; closed.stop(true);
  await expect(requestComposerCatalog({ ...endpoint, origin })).rejects.toThrow();
});
