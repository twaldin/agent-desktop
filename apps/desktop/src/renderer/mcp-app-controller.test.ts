import { expect, test } from "bun:test";
import type { DesktopBridge, NativeMcpAppRequest, NativeMcpAppResponse } from "@agent-desktop/shared";
import { McpAppController } from "./mcp-app-controller";
import { parseNativeMcpAppRequest, parseNativeMcpAppResource } from "@agent-desktop/shared";
import { mcpAppDockTab } from "./mcp-app-dock";
import { defaultWindowView, parseWindowView } from "../window-state";
import { createDockState, insertDockTab } from "./dock-state";
const app = { title: "Counter", toolName: "counter", resourceUri: "ui://counter", serverName: "original", instanceId: "original" };
const selection = { epoch: "worker", expectedRevision: 1, serverName: app.serverName, toolName: app.toolName, resourceUri: app.resourceUri };
const resource = { uri: app.resourceUri, mimeType: "text/html;profile=mcp-app", html: "<h1>Counter</h1>" };
function setup() {
  const calls: { session: string; host: string; request: NativeMcpAppRequest }[] = [];
  let dispatch = async (request: NativeMcpAppRequest): Promise<NativeMcpAppResponse> => request.type === "open" ? { type: "opened", channelId: request.channelId, resource }
    : request.type === "events" ? { type: "events", channelId: request.channelId, sequence: request.after, uris: [] } : request.type === "close" ? { type: "closed", channelId: request.channelId } : { type: "result", channelId: request.channelId, requestId: request.requestId, value: { result: "original" } };
  const bridge = { sessionMcpApp: async (session: string, request: NativeMcpAppRequest, host: string) => { calls.push({ session, request, host }); return dispatch(request); },
    getSessionMcp: async () => ({ value: { epoch: "worker", revision: 1, canOpenApps: true, servers: [{ name: "original", status: "connected", apps: [app] }] } }) } as unknown as DesktopBridge;
  const controller = new McpAppController(bridge, "host-a", "session-a", app); controller.connected(true);
  return { calls, controller, change(next: typeof dispatch) { dispatch = next; } };
}
test("close waits for the dispatched open settlement and then retires its original channel", async () => {
  const fixture = setup(), gate = Promise.withResolvers<NativeMcpAppResponse>();
  fixture.change(async request => request.type === "open" ? gate.promise : { type: "closed", channelId: request.channelId });
  const opening = fixture.controller.open(selection); void opening.catch(() => {});
  await Bun.sleep(0); const open = fixture.calls[0]!;
  expect(open).toMatchObject({ session: "session-a", host: "host-a", request: { type: "open", selection } });
  let closed = false; const closing = fixture.controller.close().then(() => { closed = true; });
  await Bun.sleep(0); expect(closed).toBe(false); expect(fixture.calls).toHaveLength(1);
  gate.resolve({ type: "opened", channelId: open.request.channelId, resource });
  await expect(opening).rejects.toThrow("original"); await closing;
  expect(fixture.calls.map(value => value.request.type)).toEqual(["open", "close"]);
  expect(fixture.calls[1]?.request.channelId).toBe(open.request.channelId);
  await fixture.controller.dispose(); expect(fixture.calls).toHaveLength(2);
});
test("connection loss is latched across an old result and fresh UI opening uses a new channel", async () => {
  const fixture = setup(); await fixture.controller.open(selection);
  const gate = Promise.withResolvers<NativeMcpAppResponse>();
  let request: Extract<NativeMcpAppRequest, { type: "request" }> | undefined;
  fixture.change(async input => { if (input.type === "request") { request = input; return gate.promise; } return input.type === "close" ? { type: "closed", channelId: input.channelId } : { type: "opened", channelId: input.channelId, resource }; });
  const pending = fixture.controller.request("tools/call", { name: "increment" }); void pending.catch(() => {});
  await Bun.sleep(0); fixture.controller.connected(false); fixture.controller.connected(true);
  gate.resolve({ type: "result", channelId: request!.channelId, requestId: request!.requestId, value: { count: 1 } });
  await expect(pending).rejects.toThrow("original");
  await fixture.controller.open();
  const opens = fixture.calls.filter(value => value.request.type === "open"); expect(opens).toHaveLength(2);
  expect(opens[1]!.request.channelId).not.toBe(opens[0]!.request.channelId);
  expect(fixture.calls.every(value => value.host === "host-a" && value.session === "session-a")).toBe(true);
  await fixture.controller.dispose();
});
test("strict app input rejects sparse JSON and CSP injection; window persistence keeps descriptor without live admission", () => {
  expect(() => parseNativeMcpAppRequest({ type: "request", channelId: "a", requestId: "b", method: "tools/call", params: { arguments: new Array(1) } })).toThrow();
  expect(() => parseNativeMcpAppResource({ ...resource, csp: { resourceDomains: ["https://safe.invalid; default-src *"] } })).toThrow();
  expect(parseNativeMcpAppResource({ ...resource, csp: { connectDomains: ["wss://provider.invalid"] } }).csp?.connectDomains).toEqual(["wss://provider.invalid"]);
  const tab = { ...mcpAppDockTab("host-a", "session-a", app, "original"), mcpAppSelection: selection };
  const state = { ...defaultWindowView(), dock: { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] } };
  const restored = parseWindowView(state);
  expect(restored?.dock?.tabs[0]?.mcpApp).toEqual(tab.mcpApp);
  expect(restored?.dock?.tabs[0]?.mcpAppSelection).toBeUndefined();
});
test("simultaneous Open joins one reservation, and close before dispatch cannot create a late channel", async () => {
  const fixture = setup();
  const first = fixture.controller.open(selection), second = fixture.controller.open(selection);
  void first.catch(() => {}); void second.catch(() => {});
  await fixture.controller.close();
  await expect(first).rejects.toThrow("original"); await expect(second).rejects.toThrow("original");
  expect(fixture.calls.map(value => value.request.type)).toEqual(["close"]);
  await fixture.controller.open(selection);
  expect(fixture.calls.filter(value => value.request.type === "open")).toHaveLength(1);
  await fixture.controller.dispose();
});
test("a deliberate retry drains the same failed close before opening a fresh app", async () => {
  const fixture = setup(); await fixture.controller.open(selection);
  let fail = true;
  fixture.change(async input => { if (input.type === "close") { if (fail) throw new Error("Host unavailable"); return { type: "closed", channelId: input.channelId }; } return { type: "opened", channelId: input.channelId, resource }; });
  await expect(fixture.controller.close()).rejects.toThrow("Host unavailable"); fail = false;
  await fixture.controller.open(selection);
  const closes = fixture.calls.filter(value => value.request.type === "close");
  expect(closes).toHaveLength(2); expect(closes[0]?.request.channelId).toBe(closes[1]?.request.channelId);
  expect(fixture.calls.map(value => value.request.type)).toEqual(["open", "close", "close", "open"]);
  await fixture.controller.dispose();
});
test("confirmed close error is visible before deliberate dismissal, and reentrant close listeners share the original drain", async () => {
  const fixture = setup(); await fixture.controller.open(selection);
  fixture.change(async input => ({ type: "closed", channelId: input.channelId, operationErrors: 1 }));
  let nested: Promise<void> | undefined, notifications = 0;
  const stop = fixture.controller.subscribeClose(() => { notifications++; nested = fixture.controller.close(); void nested.catch(() => {}); });
  const first = fixture.controller.close(); void first.catch(() => {});
  const settled = await Promise.allSettled([first, nested!]);
  expect(settled.filter(value => value.status === "rejected")).toHaveLength(2);
  for (const value of settled) if (value.status === "rejected") expect(String(value.reason)).toContain("channel is closed, but a pending operation ended with an error");
  expect(notifications).toBe(1);
  expect(fixture.calls.map(value => value.request.type)).toEqual(["open", "close"]);
  stop(); await fixture.controller.close();
  expect(fixture.calls.map(value => value.request.type)).toEqual(["open", "close"]);
  await fixture.controller.dispose();
});

test("retained result restoration sends saved input/result and never calls the historical tool", async () => {
  const f = setup(), source = { type: "artifact" as const, entryId: "entry" };
  const controller = new McpAppController(f.controller.bridge, "host-a", "session-a", { ...app, source }); controller.connected(true);
  f.change(async input => input.type === "open" ? { type: "opened", channelId: input.channelId, resource, initialArguments: { actual: 3 }, initialResult: { content: [], structuredContent: { saved: 8 } } } : { type: "closed", channelId: input.channelId });
  await controller.open(); expect(controller.initialArguments()).toEqual({ actual: 3 });
  expect(await controller.initialResult()).toEqual({ content: [], structuredContent: { saved: 8 } });
  expect(f.calls.map(value => value.request.type)).toEqual(["open"]); expect(f.calls[0]?.request).toMatchObject({ source });
  await controller.dispose();
});
test("an older host without saved-result support fails explicitly without replaying the tool", async () => {
  const f = setup(); const controller = new McpAppController(f.controller.bridge, "host-a", "session-a", { ...app, source: { type: "artifact", entryId: "entry" } }); controller.connected(true);
  await expect(controller.open()).rejects.toThrow("cannot be replayed"); await controller.dispose();
  expect(f.calls.map(value => value.request.type)).toEqual(["open", "close"]);
});
