import { expect, test } from "bun:test";
import { SESSION_FORCE_TOOL_OWNER_HEADER, type ForceToolResponse } from "@agent-desktop/shared";
import { requestForceToolState } from "./force-tool-transport";
const endpoint = { origin: "https://owner.invalid", hostId: "owner" };
const unavailable = (sessionId: string, commandId?: string): ForceToolResponse => ({
  protocolVersion: 1, hostId: "owner", sessionId, value: null, unavailable: "Worker unavailable",
  ...(commandId === undefined ? {} : { receipt: { commandId, state: "absent" } }),
});

test("read transport uses the shared owner header and parses the real shared response schema", async () => {
  const previous = globalThis.fetch; const calls: unknown[] = []; const body = unavailable("session/name", "command");
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => { calls.push({ url, init }); return Response.json(body, { headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: "owner" } }); }) as unknown as typeof fetch;
  try {
    expect(await requestForceToolState(endpoint, "session/name", "command")).toEqual(body);
    expect(calls).toEqual([{ url: "https://owner.invalid/v1/sessions/session%2Fname/force-tool?commandId=command", init: expect.objectContaining({
      redirect: "error", headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: "owner" },
    }) }]);
  } finally { globalThis.fetch = previous; }
});
test("owner mismatch, malformed JSON and oversized response are rejected before shared parsing", async () => {
  const previous = globalThis.fetch;
  try {
    for (const response of [Response.json(unavailable("session"), { headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: "other" } }), new Response("{", { headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: "owner" } }),
      new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: "owner" } })]) {
      globalThis.fetch = (async () => response) as unknown as typeof fetch;
      await expect(requestForceToolState(endpoint, "session")).rejects.toThrow();
    }
  } finally { globalThis.fetch = previous; }
});
test("host refusal remains a refusal and the shared parser rejects malformed successful payload", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ error: { code: "STALE_TARGET", message: "Owner session changed" } }, { status: 409, headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
    await expect(requestForceToolState(endpoint, "session")).rejects.toMatchObject({ code: "STALE_TARGET" });
    globalThis.fetch = (async () => Response.json({}, { headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: "owner" } })) as unknown as typeof fetch;
    await expect(requestForceToolState(endpoint, "session")).rejects.toThrow("Invalid native force-tool");
  } finally { globalThis.fetch = previous; }
});
