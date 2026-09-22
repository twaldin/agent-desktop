import { expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER } from "../../../../packages/shared/src/session-activity";
import type { SessionSubagentsResult } from "../../../../packages/shared/src/session-subagents";
import { SessionSubagentsHttp, type SessionSubagentsHandle } from "../../../host/src/session-subagents-http";
import { requestSessionSubagents } from "./session-subagents-transport";

const owner = { nativeSessionId: "root", epoch: "epoch-a" };
const target = { id: "w-a", sessionId: "child-native", guard: "generation-a" };
const detail = (): SessionSubagentsResult => ({ action: "transcript", owner, target, availability: "available", messages: [{ id: "entry-a", role: "assistant", text: "Original child only" }], truncated: false });
const request = { action: "transcript", owner, target } as const;
function endpoint(route: (request: Request) => Promise<Response | undefined>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => await route(request) ?? new Response(null, { status: 404 }) });
  return { server, host: { hostId: "host-a", origin: `http://127.0.0.1:${server.port}`, token: "disposable" } };
}

test("child transcript read never moves to a replacement loaded root while awaiting its reply", async () => {
  const pending = Promise.withResolvers<SessionSubagentsResult>(), entered = Promise.withResolvers<void>();
  let reads = 0;
  let handle: SessionSubagentsHandle | undefined = { nativeSubagents: async () => { reads++; entered.resolve(); return pending.promise; } };
  const http = new SessionSubagentsHttp({ hostId: "host-a", sessionExists: () => true, getExistingHandle: async () => handle });
  const { server, host } = endpoint(input => http.route(input));
  try {
    const reading = requestSessionSubagents(host, "root", request); void reading.catch(() => {});
    await entered.promise;
    handle = { nativeSubagents: async () => { throw new Error("Replacement root must not be queried"); } };
    pending.resolve(detail());
    await expect(reading).rejects.toMatchObject({ code: "STALE_OWNER" });
    expect(reads).toBe(1);
  } finally { await server.stop(true); }
});

test("retiring catalog ownership during a child read discards the response", async () => {
  const pending = Promise.withResolvers<SessionSubagentsResult>(), entered = Promise.withResolvers<void>();
  let exists = true;
  const handle = { nativeSubagents: async () => { entered.resolve(); return pending.promise; } };
  const http = new SessionSubagentsHttp({ hostId: "host-a", sessionExists: () => exists, getExistingHandle: async () => handle });
  const { server, host } = endpoint(input => http.route(input));
  try {
    const reading = requestSessionSubagents(host, "root", request); void reading.catch(() => {});
    await entered.promise; exists = false; pending.resolve(detail());
    await expect(reading).rejects.toMatchObject({ code: "STALE_OWNER" });
  } finally { await server.stop(true); }
});

test("a child read fails closed when same id returns a different generation", async () => {
  const handle = { nativeSubagents: async (): Promise<SessionSubagentsResult> => ({ ...detail(), target: { ...target, guard: "replacement" } } as SessionSubagentsResult) };
  const http = new SessionSubagentsHttp({ hostId: "host-a", sessionExists: () => true, getExistingHandle: async () => handle });
  const { server, host } = endpoint(input => http.route(input));
  try { await expect(requestSessionSubagents(host, "root", request)).rejects.toMatchObject({ code: "SUBAGENTS_FAILED" }); }
  finally { await server.stop(true); }
});

test("unloaded roots remain unavailable and malformed browse controls never reach native code", async () => {
  let acquisitions = 0;
  const http = new SessionSubagentsHttp({ hostId: "host-a", sessionExists: () => true, getExistingHandle: async () => { acquisitions++; return undefined; } });
  const { server, host } = endpoint(input => http.route(input));
  try {
    await expect(requestSessionSubagents(host, "root", { action: "list" })).rejects.toMatchObject({ code: "OWNER_UNAVAILABLE" });
    const rejected = await fetch(`${host.origin}/v1/sessions/root/subagents`, { method: "POST", headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "host-a" }, body: JSON.stringify({ action: "resume", owner, target }) });
    expect(rejected.status).toBe(400);
    expect(acquisitions).toBe(1);
  } finally { await server.stop(true); }
});

test("captured connection and original host identity survive endpoint mutation", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { server, host } = endpoint(async () => {
    entered.resolve(); await release.promise;
    return Response.json({ protocolVersion: 1, hostId: "host-a", sessionId: "root", result: detail() }, { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "host-a" } });
  });
  try {
    const reading = requestSessionSubagents(host, "root", request);
    await entered.promise; host.hostId = "foreign"; host.origin = "http://127.0.0.1:1"; release.resolve();
    const result = (await reading).result;
    expect(result.action).toBe("transcript");
    if (result.action !== "transcript") throw new Error("Wrong reply");
    expect(result.messages.map(message => message.text)).toEqual(["Original child only"]);
  } finally { await server.stop(true); }
});

test("foreign owner header rejects a response even when its body claims the original child", async () => {
  const { server, host } = endpoint(async () => Response.json({ protocolVersion: 1, hostId: "host-a", sessionId: "root", result: detail() }, { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: "host-b" } }));
  try { await expect(requestSessionSubagents(host, "root", request)).rejects.toMatchObject({ code: "OWNER_MISMATCH" }); }
  finally { await server.stop(true); }
});
