import { expect, test } from "bun:test";
import { NATIVE_QUEUED_MESSAGES_OWNER_HEADER } from "../../../packages/shared/src/queued-messages";
import { QueuedMessagesHttp } from "./queued-messages-http";

const empty = { revision: 1, streaming: true, messages: [] };
const request = (method = "GET", owner = "host-a", body?: unknown) => new Request("http://host/v1/sessions/session-a/queued-messages", {
  method, headers: { [NATIVE_QUEUED_MESSAGES_OWNER_HEADER]: owner, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("queued-message HTTP binds host/session ownership and parses revision-fenced mutations", async () => {
  const calls: unknown[] = [];
  let exists = true;
  const route = new QueuedMessagesHttp({ hostId: "host-a", sessionExists: () => exists, getHandle: async () => ({
    getQueuedMessages: async () => empty,
    mutateQueuedMessages: async mutation => { calls.push(mutation); return { type: "native-queued-messages", mutation: mutation.type,
      ...("messageId" in mutation ? { messageId: mutation.messageId } : {}), snapshot: { ...empty, revision: 2 } }; },
  }) });
  const wrong = await route.route(request("GET", "host-b"));
  expect(wrong?.status).toBe(409); expect(calls).toEqual([]);
  const read = await route.route(request());
  expect(read?.headers.get(NATIVE_QUEUED_MESSAGES_OWNER_HEADER)).toBe("host-a");
  expect(await read?.json()).toMatchObject({ protocolVersion: 1, hostId: "host-a", sessionId: "session-a", revision: 1 });
  const changed = await route.route(request("POST", "host-a", { type: "remove", expectedRevision: 1, messageId: "worker:1" }));
  expect(changed?.status).toBe(200);
  expect(calls).toEqual([{ type: "remove", expectedRevision: 1, messageId: "worker:1" }]);
  const sparseEquivalent = await route.route(request("POST", "host-a", { type: "reorder", expectedRevision: 2, messageIds: [null] }));
  expect(sparseEquivalent?.status).toBe(400); expect(calls).toHaveLength(1);
  exists = false;
  expect((await route.route(request()))?.status).toBe(409);
});

test("queued-message HTTP preserves explicit native revision conflict", async () => {
  const route = new QueuedMessagesHttp({ hostId: "host-a", sessionExists: () => true, getHandle: async () => ({
    getQueuedMessages: async () => empty,
    mutateQueuedMessages: async () => { throw Object.assign(new Error("Reload the native queue."), { code: "QUEUE_CHANGED" }); },
  }) });
  const response = await route.route(request("POST", "host-a", { type: "remove", expectedRevision: 0, messageId: "worker:1" }));
  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({ error: { code: "QUEUE_CHANGED", message: "Reload the native queue." } });
});
