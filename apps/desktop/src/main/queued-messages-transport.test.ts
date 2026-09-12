import { afterAll, expect, test } from "bun:test";
import { NATIVE_QUEUED_MESSAGES_OWNER_HEADER } from "@agent-desktop/shared";
import { mutateQueuedMessages, requestQueuedMessages } from "./queued-messages-transport";

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const prefix = new URL(request.url).pathname.split("/")[1];
  const owner = prefix === "wrong" ? "other" : "owner";
  const headers = { [NATIVE_QUEUED_MESSAGES_OWNER_HEADER]: owner };
  if (prefix === "malformed") return Response.json({ protocolVersion: 1, hostId: owner, sessionId: "native",
    revision: 1, streaming: true, messages: [{ id: "duplicate", lane: "steer", text: "a", imageCount: 0, position: 0, ownership: "native", editable: false, removable: true, promotable: false },
      { id: "duplicate", lane: "steer", text: "b", imageCount: 0, position: 1, ownership: "native", editable: false, removable: true, promotable: false }] }, { headers });
  if (request.method === "POST") {
    const mutation = await request.json() as { type: "remove"; messageId: string };
    return Response.json({ protocolVersion: 1, hostId: owner, sessionId: "native", type: "native-queued-messages",
      mutation: mutation.type, messageId: mutation.messageId, snapshot: { revision: 2, streaming: true, messages: [] } }, { headers });
  }
  return Response.json({ protocolVersion: 1, hostId: owner, sessionId: "native", revision: 1, streaming: true,
    messages: [{ id: "worker:1", lane: "steer", text: "queued", imageCount: 0, position: 0,
      ownership: "desktop-pending", editable: false, removable: true, promotable: false }] }, { headers });
} });
const endpoint = (prefix: string) => ({ origin: `http://127.0.0.1:${server.port}/${prefix}`, hostId: "owner" });
afterAll(() => server.stop(true));

test("desktop queued-message transport validates the response owner and native snapshot", async () => {
  expect(await requestQueuedMessages(endpoint("ok"), "native")).toMatchObject({ hostId: "owner", sessionId: "native",
    messages: [{ id: "worker:1", ownership: "desktop-pending" }] });
  await expect(requestQueuedMessages(endpoint("wrong"), "native")).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  await expect(requestQueuedMessages(endpoint("malformed"), "native")).rejects.toThrow("Duplicate");
});

test("desktop queued-message transport sends and validates the exact mutation receipt", async () => {
  const receipt = await mutateQueuedMessages(endpoint("ok"), "native", { type: "remove", expectedRevision: 1, messageId: "worker:1" });
  expect(receipt).toEqual({ type: "native-queued-messages", mutation: "remove", messageId: "worker:1",
    snapshot: { revision: 2, streaming: true, messages: [] } });
});
