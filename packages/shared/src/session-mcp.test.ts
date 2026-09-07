import { expect, test } from "bun:test";
import { parseNativeSessionMcpSnapshot, parseNativeSessionMcpReconnect, type NativeSessionMcpSnapshot } from "./session-mcp";

const legacy: NativeSessionMcpSnapshot = {
	epoch: "epoch",
	revision: 1,
	available: true,
	servers: [{ name: "server", status: "connected", source: "project", tools: [], resourceCount: 0, promptCount: 0 }],
};

test("legacy snapshots remain valid and optional live details preserve exact identities", () => {
	expect(parseNativeSessionMcpSnapshot(legacy)).toEqual(legacy);
	const value = structuredClone(legacy) as any;
	Object.assign(value.servers[0], {
		resources: [{ uri: " fixture://resource ", name: " Resource ", description: "", mimeType: "text/plain" }],
		resourceTemplates: [{ uriTemplate: "fixture://{ value }", name: "Template" }],
		prompts: [{ name: " prompt ", arguments: [{ name: " arg ", description: "Argument", required: true }] }],
		notifications: { enabled: true, toolsListChanged: true, resourcesListChanged: false, promptsListChanged: true, resourceSubscribe: true, subscriptions: [" fixture://resource "] },
	});
	const parsed = parseNativeSessionMcpSnapshot(value);
	expect(parsed.servers[0]?.resources?.[0]).toEqual({ uri: " fixture://resource ", name: " Resource ", description: "", mimeType: "text/plain" });
	expect(parsed.servers[0]?.prompts?.[0]?.arguments?.[0]?.name).toBe(" arg ");
	expect(parsed.servers[0]?.notifications?.subscriptions).toEqual([" fixture://resource "]);
});

test("detail parser rejects malformed, excessive, and unknown metadata", () => {
	const invalidRequired = structuredClone(legacy) as any;
	invalidRequired.servers[0].prompts = [{ name: "prompt", arguments: [{ name: "arg", required: "yes" }] }];
	expect(() => parseNativeSessionMcpSnapshot(invalidRequired)).toThrow("prompt argument");

	const tooMany = structuredClone(legacy) as any;
	tooMany.servers[0].resources = Array.from({ length: 4097 }, (_, index) => ({ uri: `fixture://${index}`, name: String(index) }));
	expect(() => parseNativeSessionMcpSnapshot(tooMany)).toThrow("metadata list");

	const unknown = structuredClone(legacy) as any;
	unknown.servers[0].resources = [{ uri: "fixture://one", name: "one", headers: { Authorization: "secret" } }];
	expect(() => parseNativeSessionMcpSnapshot(unknown)).toThrow("resource field");

	const multibyte = structuredClone(legacy) as any;
	multibyte.servers[0].resources = [{ uri: `fixture://${"😀".repeat(5000)}`, name: "one" }];
	expect(() => parseNativeSessionMcpSnapshot(multibyte)).toThrow("text");

	const oversized = structuredClone(legacy) as any;
	oversized.servers[0].resources = Array.from({ length: 140 }, (_, index) => ({ uri: `fixture://${index}/${"x".repeat(16_000)}`, name: String(index) }));
	expect(() => parseNativeSessionMcpSnapshot(oversized)).toThrow("2 MiB");
});


test("reconnect tickets preserve exact server identity and reject malformed capabilities or fields", () => {
  const ticket = { epoch: "manager", expectedRevision: 2, serverName: " exact name " };
  expect(parseNativeSessionMcpReconnect(ticket)).toEqual(ticket);
  for (const invalid of [
    { ...ticket, serverName: "" }, { ...ticket, serverName: "a\0b" },
    { ...ticket, serverName: "😀".repeat(257) }, { ...ticket, expectedRevision: -1 },
    { ...ticket, expectedRevision: 1.5 }, { ...ticket, epoch: "" },
    { ...ticket, command: "external" },
  ]) expect(() => parseNativeSessionMcpReconnect(invalid)).toThrow();
  expect(parseNativeSessionMcpSnapshot({ ...legacy, canReconnect: true }).canReconnect).toBe(true);
  expect(parseNativeSessionMcpSnapshot({ ...legacy, canReconnect: false }).canReconnect).toBe(false);
  expect(parseNativeSessionMcpSnapshot(legacy).canReconnect).toBeUndefined();
  expect(() => parseNativeSessionMcpSnapshot({ ...legacy, canReconnect: "true" })).toThrow();
});


test("resource capability is optional and strictly boolean", () => {
  expect(parseNativeSessionMcpSnapshot(legacy).canReadResources).toBeUndefined();
  expect(parseNativeSessionMcpSnapshot({...legacy,canReadResources:true}).canReadResources).toBe(true);
  expect(parseNativeSessionMcpSnapshot({...legacy,canReadResources:false}).canReadResources).toBe(false);
  expect(()=>parseNativeSessionMcpSnapshot({...legacy,canReadResources:"true"})).toThrow();
});

test("authorization capability is optional for old hosts and strictly boolean when present", () => {
	const legacyServer = parseNativeSessionMcpSnapshot(legacy).servers[0]!;
	expect(legacyServer.canAuthorize).toBeUndefined();
	expect(parseNativeSessionMcpSnapshot({
		...legacy,
		servers: [{ ...legacy.servers[0], canAuthorize: true }],
	}).servers[0]?.canAuthorize).toBe(true);
	expect(parseNativeSessionMcpSnapshot({
		...legacy,
		servers: [{ ...legacy.servers[0], canAuthorize: false }],
	}).servers[0]?.canAuthorize).toBe(false);
	expect(() => parseNativeSessionMcpSnapshot({
		...legacy,
		servers: [{ ...legacy.servers[0], canAuthorize: "true" }],
	})).toThrow("authorization capability");
});
