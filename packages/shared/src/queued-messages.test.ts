import { expect, test } from "bun:test";
import { parseNativeQueuedMessageMutation, parseNativeQueuedMessagesSnapshot } from "./queued-messages";

test("queued-message wire parsers bound identities, order and native snapshots", () => {
  expect(parseNativeQueuedMessageMutation({ type: "remove", expectedRevision: 2, messageId: "worker:1" }))
    .toEqual({ type: "remove", expectedRevision: 2, messageId: "worker:1" });
  expect(parseNativeQueuedMessageMutation({ type: "reorder", expectedRevision: 2, messageIds: ["worker:2", "worker:1"] }))
    .toEqual({ type: "reorder", expectedRevision: 2, messageIds: ["worker:2", "worker:1"] });
  expect(() => parseNativeQueuedMessageMutation({ type: "reorder", expectedRevision: 2, messageIds: ["same", "same"] })).toThrow();
  expect(() => parseNativeQueuedMessageMutation({ type: "edit", expectedRevision: 2, messageId: "worker:1" })).toThrow();
  const sparseOrder = new Array(1); expect(() => parseNativeQueuedMessageMutation({ type: "reorder", expectedRevision: 2, messageIds: sparseOrder })).toThrow();
  expect(parseNativeQueuedMessagesSnapshot({ revision: 3, streaming: true, messages: [{ id: "worker:1", lane: "steer",
    text: "queued", imageCount: 0, position: 0, ownership: "desktop-pending", editable: false, removable: true, promotable: false }] }))
    .toMatchObject({ revision: 3, messages: [{ id: "worker:1", text: "queued" }] });
  expect(() => parseNativeQueuedMessagesSnapshot({ revision: 3, streaming: true, messages: [{ id: "worker:1", lane: "steer",
    text: "queued", imageCount: 0, position: 9, ownership: "native", editable: false, removable: true, promotable: false }] })).toThrow();
  const item = { id: "same", lane: "steer", text: "queued", imageCount: 0, ownership: "native", editable: false, removable: true, promotable: false };
  expect(() => parseNativeQueuedMessagesSnapshot({ revision: 3, streaming: true, messages: [{ ...item, position: 0 }, { ...item, position: 1 }] })).toThrow();
  const sparseMessages = new Array(1); expect(() => parseNativeQueuedMessagesSnapshot({ revision: 3, streaming: true, messages: sparseMessages })).toThrow();
});
