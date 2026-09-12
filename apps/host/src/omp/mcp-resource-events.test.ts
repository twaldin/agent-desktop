import { expect, test } from "bun:test";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { subscribeToResources, unsubscribeFromResources } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { subscribeMcpResource } from "./mcp-resource-events";
function fixture() {
  const calls: string[] = []; let nativeNotifications = 0;
  let dispatch = async (_method: string): Promise<unknown> => ({});
  const connection: MCPServerConnection = { name: "original", config: { command: "controlled" }, serverInfo: { name: "original", version: "1" }, capabilities: { resources: { subscribe: true } },
    transport: { connected: true, request: async <T>(method: string) => { calls.push(method); return await dispatch(method) as T; }, notify: async () => {}, close: async () => {}, onNotification: () => { nativeNotifications++; } } };
  return { connection, calls, nativeNotifications: () => nativeNotifications, change: (next: typeof dispatch) => { dispatch = next; }, update: (uri = "fixture://original") => connection.transport.onNotification?.("notifications/resources/updated", { uri }) };
}
test("manager and separate viewer claims share wire subscription; release preserves remaining native ownership and original notifications", async () => {
  const f = fixture(), signal = new AbortController().signal; let a = 0, b = 0;
  await subscribeToResources(f.connection, ["fixture://original"]);
  const first = await subscribeMcpResource(f.connection, "fixture://original", () => { a++; }, signal);
  const second = await subscribeMcpResource(f.connection, "fixture://original", () => { b++; }, signal);
  expect(f.calls).toEqual(["resources/subscribe"]);
  f.update(); expect([a, b, f.nativeNotifications()]).toEqual([1, 1, 1]);
  await first.release(); f.update(); expect([a, b]).toEqual([1, 2]); expect(f.calls).toHaveLength(1);
  await unsubscribeFromResources(f.connection, ["fixture://original"]); expect(f.calls).toHaveLength(1);
  await second.release(); expect(f.calls).toEqual(["resources/subscribe", "resources/unsubscribe"]);
  f.update(); expect([a, b, f.nativeNotifications()]).toEqual([1, 2, 3]);
});
test("one aborted viewer cannot cancel a shared subscribe; a new viewer waits for held unsubscription", async () => {
  const f = fixture(), opening = Promise.withResolvers<unknown>(), entered = Promise.withResolvers<void>();
  f.change(async () => { entered.resolve(); return opening.promise; });
  const abort = new AbortController(); let firstUpdates = 0, secondUpdates = 0;
  const first = subscribeMcpResource(f.connection, "fixture://original", () => { firstUpdates++; }, abort.signal); void first.catch(() => {});
  const second = subscribeMcpResource(f.connection, "fixture://original", () => { secondUpdates++; }, new AbortController().signal);
  await entered.promise; abort.abort(new Error("First document gone")); opening.resolve({});
  await expect(first).rejects.toThrow("First document gone"); const secondLease = await second;
  f.update(); expect([firstUpdates, secondUpdates]).toEqual([0, 1]); expect(f.calls).toEqual(["resources/subscribe"]);
  const closing = Promise.withResolvers<unknown>(), closeEntered = Promise.withResolvers<void>();
  f.change(async method => { if (method === "resources/unsubscribe") { closeEntered.resolve(); return closing.promise; } return {}; });
  const released = secondLease.release(); await closeEntered.promise;
  const third = subscribeMcpResource(f.connection, "fixture://original", () => {}, new AbortController().signal);
  await Bun.sleep(0); expect(f.calls).toEqual(["resources/subscribe", "resources/unsubscribe"]);
  closing.resolve({}); await released; const thirdLease = await third;
  expect(f.calls).toEqual(["resources/subscribe", "resources/unsubscribe", "resources/subscribe"]); await thirdLease.release();
});
test("failed subscription retains its operational error and drains original cleanup; foreign transport notifications do not deliver", async () => {
  const f = fixture(); let updates = 0;
  f.change(async method => { if (method === "resources/subscribe") throw new Error("Original subscribe failed"); return {}; });
  await expect(subscribeMcpResource(f.connection, "fixture://original", () => { updates++; }, new AbortController().signal)).rejects.toThrow("Original subscribe failed");
  expect(f.calls).toEqual(["resources/subscribe", "resources/unsubscribe"]); f.update(); expect(updates).toBe(0);
  f.change(async () => ({})); const lease = await subscribeMcpResource(f.connection, "fixture://original", () => { updates++; }, new AbortController().signal);
  const foreign = fixture(); foreign.update(); f.update("fixture://other"); expect(updates).toBe(0);
  f.update(); expect(updates).toBe(1); await lease.release();
});
