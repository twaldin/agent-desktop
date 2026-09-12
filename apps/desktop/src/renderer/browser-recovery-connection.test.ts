import { expect, test } from "bun:test";
import { BrowserNewTabController as CurrentController, createBrowserNewTab } from "./browser-new-tab";
import type { BrowserCreateObservation, BrowserCreateRequest, BrowserMetadataSnapshot, DesktopBridge } from "@agent-desktop/shared";

const Controller: typeof CurrentController = process.env.AGENT_DESKTOP_RECOVERY_CONNECTION_CONTROLLER
  ? (await import(process.env.AGENT_DESKTOP_RECOVERY_CONNECTION_CONTROLLER)).BrowserNewTabController : CurrentController;
const request: BrowserCreateRequest = { requestId: "connection-check", controlEpoch: "epoch", observedAt: 1_000_000, initialUrl: "https://example.invalid/" };
const native = { name: `desktop-${request.requestId}`, targetId: "target", backend: "worker" as const, kindTag: "headless" as const,
  state: "alive" as const, title: "Existing page", url: request.initialUrl!, viewport: { width: 640, height: 480 } };
const base = { protocolVersion: 1 as const, hostId: "owner", sessionId: "session", requestId: request.requestId };
const completed: BrowserCreateObservation = { ...base, status: "settled", receipt: { ...base, outcome: "completed", workerPid: 42,
  tab: native, targetDisposition: "created-page" } };
const rejected: BrowserCreateObservation = { ...base, status: "settled", receipt: { ...base, outcome: "rejected", message: "Not acquired" } };
const metadata: BrowserMetadataSnapshot = { protocolVersion: 1, hostId: "owner", sessionId: "session", availability: "running", workerPid: 42, tabs: [native] };

function fixture(phase: "status" | "metadata", observed = completed) {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const calls: string[] = [], attached: unknown[] = [];
  const bridge: Pick<DesktopBridge, "getBrowserCreationStatus" | "getBrowserMetadata" | "createBrowserTab"> = {
    getBrowserCreationStatus: async (session, input, host) => {
      expect([host, session, input]).toEqual(["owner", "session", request]);
      calls.push("status");
      if (phase === "status") { started.resolve(); await release.promise; }
      return observed;
    },
    getBrowserMetadata: async (session, host) => {
      expect([host, session]).toEqual(["owner", "session"]);
      calls.push("metadata");
      if (phase === "metadata") { started.resolve(); await release.promise; }
      return metadata;
    },
    createBrowserTab: async () => { calls.push("create"); throw new Error("Unexpected acquisition"); },
  };
  const tab = { ...createBrowserNewTab("owner", "session", "instance"), browserNewTab: { status: "unknown" as const, request, draft: "retained address" } };
  const controller = new Controller(bridge, tab, () => {}, (...args) => attached.push(args), async () => {
    calls.push("checkpoint"); throw new Error("Unexpected submission");
  });
  controller.connected = true;
  return { controller, calls, attached, started, release };
}

for (const phase of ["status", "metadata"] as const) {
  test(`disconnect/reconnect during ${phase} invalidates that check until another explicit check`, async () => {
    const f = fixture(phase), originalRequest = f.controller.state.request;
    try {
      const running = f.controller.inspect(); await f.started.promise;
      f.controller.connected = false; f.controller.connected = true;
      await f.controller.inspect(); // Reconnect cannot admit another check while the first is pending.
      f.release.resolve(); await running;
      expect(f.attached).toEqual([]);
      expect(f.controller.state).toMatchObject({ status: "unknown", draft: "retained address", request });
      expect(f.controller.state.request).toBe(originalRequest);
      expect(f.controller.checking).toBe(false);
      expect(f.calls).toEqual(phase === "status" ? ["status"] : ["status", "metadata"]);
      await f.controller.submit(); f.controller.edit("do not replace");
      expect(f.controller.state.draft).toBe("retained address");
      expect(f.calls).toEqual(phase === "status" ? ["status"] : ["status", "metadata"]);
      await f.controller.inspect(); // The user explicitly starts a fresh generation's read-only check.
      expect(f.attached).toEqual([[{ workerPid: 42, name: native.name, targetId: native.targetId }, "Existing page"]]);
      expect(f.calls).toEqual(phase === "status" ? ["status", "status", "metadata"] : ["status", "metadata", "status", "metadata"]);
    } finally { f.release.resolve(); f.controller.dispose(); }
  });

  test(`repeated online assignment during ${phase} leaves the current check usable`, async () => {
    const f = fixture(phase);
    try {
      const running = f.controller.inspect(); await f.started.promise;
      f.controller.connected = true; f.controller.connected = true;
      f.release.resolve(); await running;
      expect(f.attached).toHaveLength(1);
      expect(f.calls).toEqual(["status", "metadata"]);
    } finally { f.release.resolve(); f.controller.dispose(); }
  });
}

test("a pre-disconnect definite rejection cannot unlock a reconnected unknown launcher", async () => {
  const f = fixture("status", rejected);
  try {
    const running = f.controller.inspect(); await f.started.promise;
    f.controller.connected = false; f.controller.connected = true;
    f.release.resolve(); await running;
    expect(f.controller.state).toMatchObject({ status: "unknown", request, draft: "retained address" });
    f.controller.edit("not yet"); await f.controller.submit();
    expect(f.controller.state.draft).toBe("retained address");
    expect(f.calls).toEqual(["status"]); expect(f.attached).toEqual([]);
    await f.controller.inspect();
    expect(f.controller.state).toMatchObject({ status: "rejected", request, draft: "retained address" });
    expect(f.calls).toEqual(["status", "status"]);
  } finally { f.release.resolve(); f.controller.dispose(); }
});
