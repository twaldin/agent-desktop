import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WORKSPACE_OWNER_HEADER } from "@agent-desktop/shared";
import { requestTerminalCreationCapabilities } from "../../desktop/src/main/terminal-create-transport";

// Keep the unavailable dispatch real; authentication and a working native bundle
// are separate contracts. This regression must not turn a 503 into a foreign host.
const source = readFileSync(process.env.TERMINAL_UNAVAILABLE_SERVER ?? new URL("./server.ts", import.meta.url), "utf8");
const start = source.indexOf('        if (url.pathname.startsWith("/v2/terminals/")) {');
const end = source.indexOf('        if (request.method === "POST" && url.pathname === "/v1/workspace/query")', start);
if (start < 0 || end < start) throw new Error("Terminal server fallback not found");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`
  async function route(request: Request, hostId: string) {
    const url = new URL(request.url), store = { host: { id: hostId } };
    const nativeTerminalsHttp = undefined, terminalCreationHttp = undefined;
    ${source.slice(start, end)}
    throw new Error("Unmatched terminal route");
  }
`);
const route = new Function("WORKSPACE_OWNER_HEADER", `${compiled}; return route;`)(WORKSPACE_OWNER_HEADER) as
  (request: Request, hostId: string) => Promise<Response>;
const hostId = "11111111-1111-4111-8111-111111111111";

test("unavailable terminal creation actions carry the serving host, never the request owner", async () => {
  for (const action of ["creation-capabilities", "create", "creation-status"]) {
    const response = await route(new Request(`http://127.0.0.1/v2/terminals/${action}`, {
      method: action === "creation-capabilities" ? "GET" : "POST",
      headers: { [WORKSPACE_OWNER_HEADER]: "foreign-host" },
    }), hostId);
    expect(response.status).toBe(503);
    expect(response.headers.get(WORKSPACE_OWNER_HEADER)).toBe(hostId);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "NATIVE_TERMINAL_BUNDLE_MISSING" } });
  }
});

test("actual terminal reader reports unavailability and still rejects foreign responses", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) =>
    route(new Request(input, init), hostId), { preconnect() {} }) as typeof fetch;
  try {
    const endpoint = { origin: "http://127.0.0.1", hostId, token: "test-only" };
    await expect(requestTerminalCreationCapabilities(endpoint)).rejects.toMatchObject({ status: 503, code: "NATIVE_TERMINAL_BUNDLE_MISSING" });
    await expect(requestTerminalCreationCapabilities({ ...endpoint, hostId: "22222222-2222-4222-8222-222222222222" })).rejects.toThrow("belongs to another host");
  } finally { globalThis.fetch = previous; }
});
