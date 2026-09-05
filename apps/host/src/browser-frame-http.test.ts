import { expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, type NativeBrowserFrame } from "@agent-desktop/shared";
import { jpeg3x2 } from "../../../packages/shared/src/fixtures/browser-frame";
import { BrowserFrameHttp } from "./browser-frame-http";

const target = { workerPid: 42, name: "main", targetId: "real-target" };
const frame: NativeBrowserFrame = { name: target.name, targetId: target.targetId, capturedAt: 1, mimeType: "image/jpeg", data: jpeg3x2, width: 3, height: 2, title: "", url: "about:blank" };
const request = (overrides = {}, owner = "host") => new Request("http://host/v1/sessions/session/browser-frame?" + new URLSearchParams({ workerPid: "42", name: "main", targetId: "real-target", ...overrides }), { headers: { [BROWSER_METADATA_OWNER_HEADER]: owner } });

test("viewport reads reject wrong owners and absent workers without creating work", async () => {
  let lookups = 0;
  const http = new BrowserFrameHttp({ hostId: "host", sessionExists: () => true, getExistingHandle: async () => { lookups++; return undefined; } });
  expect((await http.route(request({}, "other")))?.status).toBe(409); expect(lookups).toBe(0);
  expect((await http.route(request()))?.status).toBe(409); expect(lookups).toBe(1);
  expect((await http.route(request({ workerPid: "0" })))?.status).toBe(400); expect(lookups).toBe(1);
});

test("concurrent viewers share a capture and responses retain exact identity without extra fields", async () => {
  const gate = Promise.withResolvers<NativeBrowserFrame>(); let captures = 0;
  const handle = { workerPid: 42, getBrowserFrame: async () => { captures++; return gate.promise; } };
  const http = new BrowserFrameHttp({ hostId: "host", sessionExists: () => true, getExistingHandle: async () => handle });
  const first = http.route(request()), second = http.route(request());
  await Bun.sleep(0); expect(captures).toBe(1);
  gate.resolve({ ...frame, privateEndpoint: "must not escape" } as NativeBrowserFrame);
  const responses = await Promise.all([first, second]);
  for (const response of responses) {
    expect(response?.status).toBe(200); expect(response?.headers.get("cache-control")).toBe("no-store");
    const value = await response!.json(); expect(value).toMatchObject({ hostId: "host", sessionId: "session", workerPid: 42, targetId: "real-target" }); expect(value).not.toHaveProperty("privateEndpoint");
  }
});

test("replacement during capture discards pixels and capture failures release the next read", async () => {
  const gate = Promise.withResolvers<NativeBrowserFrame>();
  const handle = { workerPid: 42, getBrowserFrame: async () => gate.promise };
  let current = handle;
  const http = new BrowserFrameHttp({ hostId: "host", sessionExists: () => true, getExistingHandle: async () => current });
  const pending = http.route(request()); await Bun.sleep(0);
  current = { workerPid: 43, getBrowserFrame: async () => frame }; gate.resolve(frame);
  expect((await pending)?.status).toBe(409);
  let failed = true;
  current = { workerPid: 42, getBrowserFrame: async () => { if (failed) throw new Error("private endpoint failure"); return frame; } };
  const rejected = await http.route(request()); expect(rejected?.status).toBe(503); expect(await rejected!.text()).not.toContain("private endpoint");
  failed = false; expect((await http.route(request()))?.status).toBe(200);
});

test("native response cannot substitute another target or image size", async () => {
  let change = { targetId: "other" } as Partial<NativeBrowserFrame>;
  const handle = { workerPid: 42, getBrowserFrame: async () => ({ ...frame, ...change }) };
  const http = new BrowserFrameHttp({ hostId: "host", sessionExists: () => true, getExistingHandle: async () => handle });
  expect((await http.route(request()))?.status).toBe(503);
  change = { width: 4 }; expect((await http.route(request()))?.status).toBe(503);
});
