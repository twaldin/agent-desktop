import { expect, test } from "bun:test";
import type { CommandEnvelope } from "@agent-desktop/shared";
import { commandEndpoint, requestVersionedCommand, requestVersionedControl } from "./command-endpoints";
import { HostRequestError, requestHost } from "./host-transport";

test("an old HTTP host cannot silently strip a permission choice or receive a fallback copy", async () => {
  const requests: string[] = [];
  const old = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    return path.startsWith("/v2/") ? Response.json({ error: "Not found" }, { status: 404 }) : Response.json({ ok: true });
  } });
  const draft = { id: "new-conversation", text: "retained", projectId: null, model: null, approvalMode: "always-ask" as const };
  const envelopes: CommandEnvelope[] = [
    { id: "save", command: { type: "draft.put", draft, expectedRevision: 0 } },
    { id: "create", command: { type: "session.create", projectId: null, approvalMode: "always-ask" } },
    { id: "prompt", command: { type: "session.prompt", sessionId: "s", text: "retained", approvalMode: "write" } },
    { id: "steer", command: { type: "session.steer", sessionId: "s", text: "retained", approvalMode: "yolo" } },
  ];
  try {
    const request = (path: string, body: unknown) => requestHost({ origin: old.url.origin, hostId: "old" }, path, body);
    for (const envelope of envelopes) expect(await requestVersionedCommand(request, envelope)).toMatchObject({ ok: false, commandId: envelope.id, error: { code: "PERMISSION_PROTOCOL_UNSUPPORTED" } });
    expect(requests).toEqual(envelopes.map(() => "/v2/commands"));
    await expect(requestVersionedControl(request, "session/owned", { expectedRevision: "r", operation: "override", path: "tools.approvalMode", value: "write" })).rejects.toThrow("Update the owning host");
    await expect(requestVersionedControl(request, "s", { expectedRevision: "r", operation: "clear-override", path: "tools.approvalMode" })).rejects.toThrow("Update the owning host");
    expect(requests.slice(-2)).toEqual(["/v2/sessions/session%2Fowned/controls", "/v2/sessions/s/controls"]);
    const ordinary: CommandEnvelope = { id: "ordinary", command: { type: "session.prompt", sessionId: "s", text: "unchanged", approvalMode: undefined } };
    expect(commandEndpoint(ordinary)).toBe("/v1/commands");
    expect(await requestVersionedCommand(request, ordinary)).toEqual({ ok: true });
  } finally { old.stop(true); }
});

test("an uncertain policy delivery or coded error is never changed into a definite rejection", async () => {
  const envelope: CommandEnvelope = { id: "original", command: { type: "session.create", projectId: null, approvalMode: "write" } };
  for (const error of [new Error("socket lost after admission"), new HostRequestError("denied", 401), new HostRequestError("native file missing", 404, "NATIVE_MISSING")]) {
    let calls = 0;
    await expect(requestVersionedCommand(async () => { calls++; throw error; }, envelope)).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});
