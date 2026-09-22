import { expect, test } from "bun:test";
import type { CommandEnvelope } from "@agent-desktop/shared";
import { parseCommandEnvelope } from "./validation";
import { commandEndpoint, requestVersionedCommand } from "../../desktop/src/main/command-endpoints";
import { HostRequestError, requestHost } from "../../desktop/src/main/host-transport";

const ticket = { nativeSessionId: "owned-session", epoch: "worker-epoch", revision: "history-revision" };
const reset: CommandEnvelope = { id: "original-reset", commandVersion: 25,
  command: { type: "session.tree.mutate", sessionId: ticket.nativeSessionId, ticket, mutation: { action: "reset-context", origin: "clear-command" } } };

test("clear context requires its exact command and endpoint versions before native admission", () => {
  expect(parseCommandEnvelope(reset, 25)).toEqual(reset);
  for (const version of [undefined, 1, 23, 24] as const) {
    expect(() => parseCommandEnvelope({ ...reset, commandVersion: version }, 25)).toThrow();
    if (version !== undefined) expect(() => parseCommandEnvelope(reset, version)).toThrow();
  }
  const label: CommandEnvelope = { ...reset, commandVersion: 23,
    command: { ...reset.command, type: "session.tree.mutate", sessionId: ticket.nativeSessionId, ticket, mutation: { action: "label", targetId: "entry", label: "Keep" } } };
  expect(parseCommandEnvelope(label, 23)).toEqual(label);
  expect(commandEndpoint(label)).toBe("/v23/commands");
  expect(() => parseCommandEnvelope({ ...label, commandVersion: 25 }, 25)).toThrow();
  expect(() => parseCommandEnvelope({ ...reset, command: { type: "session.prompt", sessionId: ticket.nativeSessionId, text: "Keep this draft" } }, 25)).toThrow();
});

test("an older actual HTTP host receives no downgraded reset request", async () => {
  const paths: string[] = [];
  const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    return Response.json({ error: "Not found" }, { status: 404 });
  } });
  try {
    const result = await requestVersionedCommand((path, body) => requestHost({ origin: host.url.origin, hostId: "original-host" }, path, body), reset);
    expect(result).toMatchObject({ ok: false, commandId: reset.id, error: { code: "TREE_RESET_PROTOCOL_UNSUPPORTED" } });
    expect(paths).toEqual(["/v25/commands"]);
  } finally { host.stop(true); }
});

test("uncertain reset delivery and a coded native error are never classified as unsupported", async () => {
  for (const failure of [new Error("Response lost after reset admission"), new HostRequestError("Native owner missing", 404, "OWNER_MISSING")]) {
    const paths: string[] = [];
    await expect(requestVersionedCommand(async path => { paths.push(path); throw failure; }, reset)).rejects.toThrow(failure.message);
    expect(paths).toEqual(["/v25/commands"]);
  }
});
