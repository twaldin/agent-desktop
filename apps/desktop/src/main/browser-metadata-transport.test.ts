import { afterEach, expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER } from "@agent-desktop/shared";
import { HostRequestError } from "./host-transport";
import { requestBrowserMetadata } from "./browser-metadata-transport";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("desktop browser metadata client binds the owner header and response identity", async () => {
  globalThis.fetch = (async (_input, init) => {
    expect(new Headers(init?.headers).get(BROWSER_METADATA_OWNER_HEADER)).toBe("host");
    return new Response(JSON.stringify({ protocolVersion: 1, hostId: "host", sessionId: "session", availability: "not-started", reason: "No worker" }), { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } });
  }) as typeof fetch;
  await expect(requestBrowserMetadata({ origin: "http://host", hostId: "host", token: "token" }, "session")).resolves.toMatchObject({ availability: "not-started" });
});

test("desktop browser metadata client preserves a valid optional creation ticket", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ protocolVersion: 1, hostId: "host", sessionId: "session",
    availability: "not-started", reason: "No worker", creationTicket: { controlEpoch: "process-epoch", observedAt: 1234 } }),
  { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } })) as unknown as typeof fetch;
  await expect(requestBrowserMetadata({ origin: "http://host", hostId: "host" }, "session")).resolves.toMatchObject({
    creationTicket: { controlEpoch: "process-epoch", observedAt: 1234 },
  });
});

test("desktop browser metadata client refuses an owner mismatch and typed remote error", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ protocolVersion: 1, hostId: "other", sessionId: "session", availability: "running", workerPid: 1, tabs: [] }), { headers: { [BROWSER_METADATA_OWNER_HEADER]: "other" } })) as unknown as typeof fetch;
  await expect(requestBrowserMetadata({ origin: "http://host", hostId: "host" }, "session")).rejects.toMatchObject({ code: "OWNER_MISMATCH" } satisfies Partial<HostRequestError>);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "STALE_TARGET", message: "gone" } }), { status: 409 })) as unknown as typeof fetch;
  await expect(requestBrowserMetadata({ origin: "http://host", hostId: "host" }, "session")).rejects.toMatchObject({ code: "STALE_TARGET" } satisfies Partial<HostRequestError>);
});

test("desktop browser metadata client rejects unknown states and malformed native tabs", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ protocolVersion: 1, hostId: "host", sessionId: "session", availability: "future" }), { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } })) as unknown as typeof fetch;
  await expect(requestBrowserMetadata({ origin: "http://host", hostId: "host" }, "session")).rejects.toThrow("invalid running fields");
  globalThis.fetch = (async () => new Response(JSON.stringify({ protocolVersion: 1, hostId: "host", sessionId: "session", availability: "running", workerPid: 0, tabs: [{ name: "tab", targetId: "target", backend: "worker", kindTag: "headless", state: "alive", url: "https://example.invalid", viewport: { width: 0, height: 100 } }] }), { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } })) as unknown as typeof fetch;
  await expect(requestBrowserMetadata({ origin: "http://host", hostId: "host" }, "session")).rejects.toThrow("invalid running fields");
  globalThis.fetch = (async () => new Response(JSON.stringify({ protocolVersion: 1, hostId: "host", sessionId: "session", availability: "running", workerPid: 1, tabs: [{ name: "tab", targetId: "target", backend: "worker", kindTag: "headless", state: "alive", url: "https://example.invalid", viewport: { width: 0, height: 100 } }] }), { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } })) as unknown as typeof fetch;
  await expect(requestBrowserMetadata({ origin: "http://host", hostId: "host" }, "session")).rejects.toThrow("invalid tab fields");
});

test("desktop browser metadata client preserves an empty native page title", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ protocolVersion: 1, hostId: "host", sessionId: "session", availability: "running", workerPid: 1,
    tabs: [{ name: "tab", targetId: "target", backend: "worker", kindTag: "headless", state: "alive", url: "about:blank", title: "", viewport: { width: 100, height: 100 } }] }),
  { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } })) as unknown as typeof fetch;
  await expect(requestBrowserMetadata({ origin: "http://host", hostId: "host" }, "session")).resolves.toMatchObject({ availability: "running", tabs: [{ title: "" }] });
});
