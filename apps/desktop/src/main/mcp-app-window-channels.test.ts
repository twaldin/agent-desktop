import { expect, test } from "bun:test";
import { McpAppWindowChannels } from "./mcp-app-window-channels";
import type { NativeMcpAppRequest, NativeMcpAppResponse } from "@agent-desktop/shared";
const endpoint = { hostId: "host", origin: "http://original" };
const open = { type: "open" as const, channelId: "channel", selection: { epoch: "epoch", expectedRevision: 1, serverName: "server", toolName: "tool", resourceUri: "ui://app" } };
const opened: NativeMcpAppResponse = { type: "opened", channelId: "channel", resource: { uri: "ui://app", html: "<p>app</p>", mimeType: "text/html;profile=mcp-app" } };
const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; };

test("retiring during endpoint lookup does not dispatch, and a new document owns its own channel", async () => {
  const lookup = gate<typeof endpoint>(), calls: string[] = [];
  const old = new McpAppWindowChannels({ current: () => true, connect: () => lookup.promise, request: async (_, __, request) => { calls.push(request.type); return opened; } });
  const opening = old.dispatch("session", "host", open); void opening.catch(() => {}); await Promise.resolve();
  const drain = old.retire(); lookup.resolve(endpoint); await expect(opening).rejects.toThrow("retired"); await drain;
  expect(calls).toEqual([]);
  const current = new McpAppWindowChannels({ current: () => true, connect: async () => endpoint, request: async (_, __, request) => { calls.push(request.type); return opened; } });
  expect(await current.dispatch("session", "host", open)).toEqual(opened);
  expect(calls).toEqual(["open"]);
});

test("late dispatched open is drained only on captured endpoint and cannot publish to retired document", async () => {
  const response = gate<NativeMcpAppResponse>(), closing = gate<void>(), calls: string[] = [];
  const mutable = { ...endpoint };
  const owner = new McpAppWindowChannels({ current: () => true, connect: async () => mutable, request: async (target, session, request) => {
    calls.push(`${target.origin}/${session}/${request.type}`);
    if (request.type === "open") return response.promise;
    await closing.promise; return { type: "closed", channelId: request.channelId };
  } });
  const opening = owner.dispatch("session", "host", open); void opening.catch(() => {});
  for (let i = 0; i < 5 && calls.length === 0; i++) await Promise.resolve();
  expect(calls).toEqual(["http://original/session/open"]);
  mutable.origin = "http://replacement";
  let drained = false; const drain = owner.retire().then(() => { drained = true; });
  expect(drained).toBe(false); response.resolve(opened);
  await expect(opening).rejects.toThrow("retired");
  for (let i = 0; i < 5 && calls.length < 2; i++) await Promise.resolve();
  expect(calls).toEqual(["http://original/session/open", "http://original/session/close"]);
  expect(drained).toBe(false); closing.resolve(); await drain; expect(drained).toBe(true);
});

test("original close can retry ambiguous failure, warning receipt remains distinct, and task identity cannot switch", async () => {
  const calls: NativeMcpAppRequest[] = [], warnings: number[] = []; let fail = true;
  const owner = new McpAppWindowChannels({ current: () => true, reportOperationErrors: count => warnings.push(count), connect: async () => endpoint, request: async (_, __, request) => {
    calls.push(request);
    if (request.type === "open") return opened;
    if (fail) { fail = false; throw new Error("Transport ended"); }
    return { type: "closed", channelId: request.channelId, operationErrors: 1 };
  } });
  await owner.dispatch("session", "host", open);
  expect(() => owner.dispatch("foreign", "host", { type: "close", channelId: "channel" })).toThrow("another task");
  await expect(owner.dispatch("session", "host", { type: "close", channelId: "channel" })).rejects.toThrow("Transport ended");
  expect(await owner.dispatch("session", "host", { type: "close", channelId: "channel" })).toEqual({ type: "closed", channelId: "channel", operationErrors: 1 });
  expect(calls.map(value => value.type)).toEqual(["open", "close", "close"]);
  await owner.retire();
  expect(warnings).toEqual([1]);
  expect(() => owner.dispatch("session", "host", open)).toThrow("retired");
});
