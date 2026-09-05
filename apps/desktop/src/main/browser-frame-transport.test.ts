import { expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameSnapshot } from "@agent-desktop/shared";
import { jpeg3x2 } from "../../../../packages/shared/src/fixtures/browser-frame";
import { requestBrowserFrame } from "./browser-frame-transport";
import { BrowserFrameHttp } from "../../../host/src/browser-frame-http";

const target = { workerPid: 42, name: "main & tab", targetId: "target" };
const frame = { ...target, capturedAt: 1, mimeType: "image/jpeg" as const, data: jpeg3x2, width: 3, height: 2, title: "", url: "about:blank" };

test("main transport reads an owner-bound frame over actual HTTP and keeps credentials out of returned data", async () => {
  const handle = { workerPid: 42, getBrowserFrame: async () => frame };
  const route = new BrowserFrameHttp({ hostId: "host", sessionExists: id => id === "session", getExistingHandle: async () => handle });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer local-test-token");
    return await route.route(request) ?? new Response("Missing", { status: 404 });
  } });
  try {
    const value = await requestBrowserFrame({ hostId: "host", token: "local-test-token", origin: server.url.origin }, "session", target);
    expect(value).toMatchObject({ workerPid: 42, name: "main & tab", targetId: "target", width: 3, height: 2 });
    expect(JSON.stringify(value)).not.toContain("local-test-token");
  } finally { server.stop(true); }
});

test("main rejects switched response owner, worker, target and oversized response bodies", async () => {
  let change = {} as Partial<BrowserFrameSnapshot>; let owner = "other", huge = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return huge ? new Response('"' + 'x'.repeat(12 * 1024 * 1024), { headers: { [BROWSER_METADATA_OWNER_HEADER]: owner } })
      : Response.json({ ...frame, protocolVersion: 1, hostId: "host", sessionId: "session", ...change }, { headers: { [BROWSER_METADATA_OWNER_HEADER]: owner } });
  } });
  try {
    const endpoint = { hostId: "host", origin: server.url.origin };
    await expect(requestBrowserFrame(endpoint, "session", target)).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    owner = "host";
    for (const patch of [{ hostId: "other" }, { workerPid: 43 }, { targetId: "other" }, { width: 4 }]) { change = patch; await expect(requestBrowserFrame(endpoint, "session", target)).rejects.toThrow(); }
    change = {}; huge = true; await expect(requestBrowserFrame(endpoint, "session", target)).rejects.toThrow("exceeds its limit");
  } finally { server.stop(true); }
});
