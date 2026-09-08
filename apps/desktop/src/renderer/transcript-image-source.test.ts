import { describe, expect, test } from "bun:test";
import type { DesktopBridge, WorkspaceTarget } from "@agent-desktop/shared";
import { createTranscriptImageResolver, resolveTranscriptImageReference } from "./transcript-image-source";

describe("transcript Markdown image references", () => {
  test("canonicalizes absolute, localhost file and sandbox paths without inventing a relative cwd", () => {
    for (const [href, path] of [
      ["/Users/owner/My%20Image.png", "/Users/owner/My Image.png"],
      ["file:///Users/owner/%E2%98%83.png?raw=1#preview", "/Users/owner/☃.png"],
      ["file://localhost/Users/owner/image.png", "/Users/owner/image.png"],
      ["sandbox:/tmp/output/./charts/../chart.webp", "/tmp/output/chart.webp"],
      ["/%F0%9F%93%81/%E5%9B%BE%E5%83%8F.avif", "/📁/图像.avif"],
    ] as const) expect(resolveTranscriptImageReference(href)).toEqual({ kind: "file", path });
    expect(resolveTranscriptImageReference("relative/image.png")).toEqual({ kind: "unavailable", reason: "Relative images require a file context." });
  });

  test("rejects malformed or nonlocal paths and classifies bounded embedded media without admitting remote fetches", () => {
    for (const href of [
      "file://other-host/tmp/image.png", "file:///tmp/%ZZ.png", "/tmp/bad%5Cname.png", "/tmp/bad%00name.png",
      "/tmp/\ud800.png", "https://example.com/tracker.png", "//example.com/tracker.png", "http://127.0.0.1/image.png",
      "sandbox:relative.png", "/", "data:text/html,not-an-image", "data:image/pngx;base64,AA==",
    ]) expect(resolveTranscriptImageReference(href).kind).toBe("unavailable");
    expect(resolveTranscriptImageReference("data:image/png;base64,iVBORw0KGgo=")).toEqual({ kind: "data", url: "data:image/png;base64,iVBORw0KGgo=" });
    expect(resolveTranscriptImageReference("data:image/svg+xml,%3Csvg%2F%3E")).toEqual({ kind: "data", url: "data:image/svg+xml,%3Csvg%2F%3E" });
  });
});

describe("owner-scoped transcript image leases", () => {
  test("uses the exact host, standalone target and basename for load and save", async () => {
    const acquired: Array<{ target: WorkspaceTarget; path: string; hostId: string }> = [];
    const saved: Array<{ target: WorkspaceTarget; path: string; hostId: string }> = [];
    const released: string[] = [];
    const bridge: Pick<DesktopBridge, "acquireWorkspaceImage" | "releaseWorkspaceImage" | "saveWorkspaceCopy"> = {
      acquireWorkspaceImage: async (target, path, hostId) => { acquired.push({ target, path, hostId }); return { id: "lease-1", url: "agent-workspace-image://image/lease-1" }; },
      releaseWorkspaceImage: async id => { released.push(id); },
      saveWorkspaceCopy: async (target, path, hostId) => { saved.push({ target, path, hostId }); return { path: "/local/copy.png" }; },
    };
    const presentation = createTranscriptImageResolver(bridge, "remote-host", () => true)("file:///remote/output/My%20Image.png");
    const lease = await presentation.source!.load();
    await presentation.download!();
    expect(acquired).toEqual([{ target: { filePath: "/remote/output/My Image.png" }, path: "My Image.png", hostId: "remote-host" }]);
    expect(saved).toEqual(acquired);
    expect(lease.url).toBe("agent-workspace-image://image/lease-1");
    await lease.release(); await lease.release();
    expect(released).toEqual(["lease-1"]);
  });

  test("denies new host work while offline and data images never call the bridge", async () => {
    let calls = 0, connected = false;
    const bridge: Pick<DesktopBridge, "acquireWorkspaceImage" | "releaseWorkspaceImage" | "saveWorkspaceCopy"> = {
      acquireWorkspaceImage: async () => { calls++; return { id: "lease", url: "agent-workspace-image://image/lease" }; },
      releaseWorkspaceImage: async () => { calls++; },
      saveWorkspaceCopy: async () => { calls++; return { path: null }; },
    };
    const resolve = createTranscriptImageResolver(bridge, "owner", () => connected);
    const file = resolve("/tmp/image.png");
    await expect(file.source!.load()).rejects.toThrow("Reconnect");
    await expect(file.download!()).rejects.toThrow("Reconnect");
    const data = resolve("data:image/webp;base64,AA=="), lease = await data.source!.load();
    expect(lease.url).toBe("data:image/webp;base64,AA=="); await lease.release();
    expect(data.download).toBeUndefined(); expect(calls).toBe(0);
    connected = true; await (await file.source!.load()).release();
    expect(calls).toBe(2);
  });

  test("fails closed when owner identity or the required grant bridge is unavailable", () => {
    for (const hostId of [undefined, "unconnected"]) {
      const result = createTranscriptImageResolver({}, hostId, () => true)("/tmp/image.png");
      expect(result.source).toBeUndefined(); expect(result.unavailableReason).toContain("owning host");
    }
    const remote = createTranscriptImageResolver({} as Pick<DesktopBridge, "acquireWorkspaceImage" | "releaseWorkspaceImage" | "saveWorkspaceCopy">, "owner", () => true)("https://example.com/image.png");
    expect(remote.source).toBeUndefined(); expect(remote.unavailableReason).toContain("Remote images");
  });
});
