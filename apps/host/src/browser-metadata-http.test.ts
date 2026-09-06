import { expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserMetadataAvailability } from "@agent-desktop/shared";
import { BrowserMetadataHttp } from "./browser-metadata-http";

const request = (owner = "host") => new Request("http://host/v1/sessions/session/browser-metadata", { headers: { [BROWSER_METADATA_OWNER_HEADER]: owner } });
const running: BrowserMetadataAvailability = { availability: "running", workerPid: 99, tabs: [{ name: "main", targetId: "target-1", backend: "worker", kindTag: "headless", state: "alive", url: "http://127.0.0.1/tab", title: "Native tab", viewport: { width: 640, height: 480 } }] };

test("browser metadata binds exact owner and does not start an absent worker", async () => {
  let calls = 0;
  const http = new BrowserMetadataHttp({ hostId: "host", sessionExists: id => id === "session", getExistingHandle: async () => { calls++; return undefined; } });
  const response = await http.route(request());
  expect(response?.status).toBe(200); expect(await response?.json()).toMatchObject({ hostId: "host", sessionId: "session", availability: "not-started" }); expect(calls).toBe(1);
});

test("browser metadata exposes a fresh optional creation ticket without starting a worker", async () => {
  let calls = 0;
  const http = new BrowserMetadataHttp({ hostId: "host", sessionExists: () => true,
    creationTicket: () => ({ controlEpoch: "process-epoch", observedAt: 1234 }),
    getExistingHandle: async () => { calls++; return undefined; } });
  expect(await (await http.route(request()))!.json()).toMatchObject({ availability: "not-started",
    creationTicket: { controlEpoch: "process-epoch", observedAt: 1234 } });
  expect(calls).toBe(1);
});

test("browser metadata rejects wrong owners and stale sessions before worker access", async () => {
  let calls = 0;
  const http = new BrowserMetadataHttp({ hostId: "host", sessionExists: () => false, getExistingHandle: async () => { calls++; return undefined; } });
  const wrong = await http.route(request("other")); expect(wrong?.status).toBe(409); expect(await wrong?.json()).toMatchObject({ error: { code: "OWNER_MISMATCH" } });
  const stale = await http.route(request()); expect(stale?.status).toBe(409); expect(await stale?.json()).toMatchObject({ error: { code: "STALE_TARGET" } }); expect(calls).toBe(0);
});

test("browser metadata reports actual running fields and suppresses a stopped worker", async () => {
  let stopped = false;
  const http = new BrowserMetadataHttp({ hostId: "host", sessionExists: () => true, getExistingHandle: async () => stopped ? { workerFailure: { message: "exit" }, getBrowserMetadata: async () => running } : { getBrowserMetadata: async () => running } });
  const live = await http.route(request()); expect(live?.status).toBe(200); expect(await live?.json()).toMatchObject({ availability: "running", workerPid: 99, tabs: [{ targetId: "target-1", url: "http://127.0.0.1/tab" }] });
  stopped = true;
  const dead = await http.route(request()); expect(dead?.status).toBe(200); expect(await dead?.json()).toMatchObject({ availability: "unavailable" });
});

test("browser metadata rechecks session lifetime after the native worker response", async () => {
  let exists = true;
  const http = new BrowserMetadataHttp({ hostId: "host", sessionExists: () => exists, getExistingHandle: async () => ({ getBrowserMetadata: async () => { exists = false; return running; } }) });
  const response = await http.route(request()); expect(response?.status).toBe(409); expect(await response?.json()).toMatchObject({ error: { code: "STALE_TARGET" } });
});
