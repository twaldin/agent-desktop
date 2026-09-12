import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCreateRequest, DraftBrowserBridge, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView } from "../window-state";
import { DraftController } from "./drafts";
import { DraftBrowserWindowOwner } from "./draft-browser-window-owner";
import { DraftBrowserWindowPages } from "./draft-browser-window-pages";

const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const owner = { version: 1 as const, hostId: "host", reference: { ownerId: "original", draftId: "draft", draftRevision: 1 } };
const native = (id: string): NativeBrowserTabMetadata => ({ name: `desktop-${id}`, targetId: `target-${id}`, backend: "worker", kindTag: "headless", state: "alive", url: "https://example.com/", title: "Page", viewport: { width: 800, height: 600 } });

for (const loss of ["project", "conflict"] as const) for (const phase of ["request", "target"] as const) {
  for (const order of ["page-first", "owner-first"] as const) {
    test(`${order}: ${loss} loss cancels ${phase} save without another commit, save or disposal`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "draft-page-project-"));
      const store = new WindowStateStore(dir, "primary"), events: string[] = [];
      const drafts = new DraftController(async () => { throw new Error("No draft write expected"); }, "host");
      // Offline local editing may establish the page listener before any owner inspection.
      const bridge: DraftBrowserBridge = {
        acquire: async () => { throw new Error("No acquisition expected"); }, retire: async () => { throw new Error("No retirement expected"); },
        status: async () => { events.push("status"); return { protocolVersion: 1, hostId: "host", ownerId: "original", state: "ready", workerPid: 55, ticket: { controlEpoch: "epoch", observedAt: 1 } }; },
        metadata: async () => { events.push("metadata"); return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "original", availability: "running", workerPid: 55, tabs: last ? [native(last.requestId)] : [] }; },
        create: async (_, request) => { events.push("create"); last = structuredClone(request); return { protocolVersion: 1, ownerKind: "draft", hostId: "host", ownerId: "original", requestId: request.requestId, outcome: "completed", workerPid: 55, tab: native(request.requestId), targetDisposition: "created-page" }; },
        creationStatus: async () => { throw new Error("No history query expected"); }, frame: async () => { throw new Error("No frame expected"); }, control: async () => { throw new Error("No control expected"); },
      };
      let last: BrowserCreateRequest | undefined;
      const owners = new DraftBrowserWindowOwner(bridge, [owner], () => {});
      const pages = new DraftBrowserWindowPages(bridge, owners, [{ version: 1, instanceId: "page", owner, launcher: { status: "idle" } }], () => {});
      const context = { drafts, draftId: "draft", connected: false, enabled: true };
      const commitContext = () => { owners.commit(context); pages.commit(context); };
      const flush = () => { const view = { ...defaultWindowView(), draftBrowserOwners: owners.intents, draftBrowserPages: pages.intents };
        owners.committed(view); pages.committed(view); expect(store.saveView(view).error).toBeUndefined(); const saved = store.bootstrap().state!; owners.saved(saved); pages.saved(saved); };
      let running: Promise<unknown> | undefined;
      try {
        commitContext(); flush(); expect(events).toEqual([]);
        if (order === "page-first") { pages.edit("page", "example.com"); expect(events).toEqual([]); }
        context.connected = true; commitContext(); flush(); await owners.inspect("original");
        if (order === "owner-first") pages.edit("page", "example.com");
        flush(); events.length = 0;
        let settled = false; running = pages.submit("page").then(() => { settled = true; }); await tick();
        expect(events).toEqual(["status"]); expect(settled).toBe(false);
        if (phase === "target") { flush(); await tick(); expect(events).toEqual(["status", "create", "metadata"]); expect(pages.intents[0]?.confirmedTarget).toBeDefined(); }
        const request = pages.intents[0]!.launcher.request, beforeLoss = [...events];
        // An unrelated draft edit must not cancel the wait.
        drafts.update("draft", { text: "retained unsent text" }); await tick(); expect(settled).toBe(false);
        if (loss === "project") drafts.update("draft", { projectId: "other-project" });
        else drafts.ingest({ ...drafts.get("draft").draft, text: "other device text", revision: 1, updatedAt: 1 });
        await tick();
        const settledOnNotification = settled, afterNotification = [...events], readyOnNotification = pages.state("page")?.ready;
        // Settle teardown before an old/fixed assertion; never count teardown as cancellation proof.
        pages.dispose(); await running;
        expect(settledOnNotification).toBe(true); expect(afterNotification).toEqual(beforeLoss);
        expect(pages.intents[0]?.launcher.request).toEqual(request); expect(drafts.get("draft").draft.text).toBe("retained unsent text");
        expect(readyOnNotification).toBeUndefined();
      } finally { pages.dispose(); owners.dispose(); await running; drafts.dispose(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
