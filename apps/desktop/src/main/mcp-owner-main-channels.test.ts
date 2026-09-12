import { expect, test } from "bun:test";
import type { IpcMainInvokeEvent } from "electron";
import type { McpOwnerRequest, McpOwnerResult, McpOwnerSnapshot } from "@agent-desktop/shared";
import { McpOwnerMainChannels } from "./mcp-owner-main-channels";

const endpoint = { hostId: "original-host", origin: "http://original.invalid", token: "controlled" };
const snapshot = (ownerId: string): McpOwnerSnapshot => ({ ownerId, epoch: `epoch:${ownerId}`, cwd: "/original", projectId: null,
  interactions: [], catalogue: { available: true, canOpenApps: true, epoch: "catalogue", revision: 1, servers: [] } });
const event = (id: number) => { const frame = {}, sender = { id, mainFrame: frame, isDestroyed: () => false };
  return { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent; };

// Exercises the same registrar used by main: the channel must exist, dispatch through
// the captured sender document, and retire only that document's native owners.
test("main MCP owner channel registers, dispatches, and drains the exact document", async () => {
  let handler: ((event: IpcMainInvokeEvent, hostId: string, request: McpOwnerRequest) => Promise<McpOwnerResult>) | undefined;
  const calls: Array<{ ownerId: string; type: string }> = [];
  const channels = new McpOwnerMainChannels({
    ipcMain: { handle: (name, value) => { expect(name).toBe("host:mcp-owner"); handler = value as NonNullable<typeof handler>; } },
    available: () => true,
    assertTrusted: () => {},
    connect: async () => endpoint,
    request: async (_endpoint, request) => { calls.push({ ownerId: request.ownerId, type: request.type });
      return request.type === "retire" ? { closed: true } : snapshot(request.ownerId); },
  });
  expect(handler).toBeDefined();
  const first = event(7), second = event(8);
  await handler!(first, endpoint.hostId, { type: "acquire", ownerId: "first", target: { projectId: null } });
  await handler!(second, endpoint.hostId, { type: "acquire", ownerId: "second", target: { projectId: null } });
  channels.retireDocument(first.sender.id); await channels.drain();
  expect(calls).toEqual([{ ownerId: "first", type: "acquire" }, { ownerId: "second", type: "acquire" }, { ownerId: "first", type: "retire" }]);
  await handler!(second, endpoint.hostId, { type: "read", ownerId: "second", epoch: "epoch:second" });
  channels.retireDocument(second.sender.id); await channels.drain();
  expect(calls.slice(-2)).toEqual([{ ownerId: "second", type: "read" }, { ownerId: "second", type: "retire" }]);
});
