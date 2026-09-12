import { expect, test } from "bun:test";
import type { CommandEnvelope } from "@agent-desktop/shared";
import { commandEndpoint, requestVersionedCommand } from "./command-endpoints";
import { HostRequestError } from "./host-transport";

const request: CommandEnvelope = {
  id: "original-shortcut-edit", commandVersion: 11,
  command: { type: "preferences.keymap.mutate", mutation: { expectedRevision: null,
    edit: { type: "command", commandId: "newTask", update: { type: "set", accelerator: "Command+Alt+N" } } } },
};

test("shortcut edits only use v11, including callers that omit their envelope version", () => {
  expect(commandEndpoint(request)).toBe("/v11/commands");
  expect(commandEndpoint({ id: request.id, command: request.command })).toBe("/v11/commands");
  expect(commandEndpoint({ id: "older-action", commandVersion: 11, command: { type: "session.interrupt", sessionId: "s" } })).toBe("/v11/commands");
});

test("only an uncoded missing endpoint establishes non-admission; no downgraded request is sent", async () => {
  const calls: unknown[] = [];
  const result = await requestVersionedCommand(async (path, body) => {
    calls.push({ path, body }); throw new HostRequestError("Not found", 404);
  }, request);
  expect(result).toEqual({ ok: false, commandId: request.id, error: {
    code: "KEYBINDINGS_PROTOCOL_UNSUPPORTED", message: "Update the owning host to change keyboard shortcuts. This request was not accepted.",
  } });
  expect(calls).toEqual([{ path: "/v11/commands", body: request }]);
});

test("authentication, coded errors, and response loss preserve uncertain-delivery handling", async () => {
  for (const error of [new HostRequestError("Denied", 401), new HostRequestError("Record missing", 404, "NOT_FOUND"), new Error("Timed out after admission")]) {
    let calls = 0;
    await expect(requestVersionedCommand(async (path, body) => {
      calls++; expect(path).toBe("/v11/commands"); expect(body).toBe(request); throw error;
    }, request)).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});
