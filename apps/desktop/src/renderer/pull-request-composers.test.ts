import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { pullRequestComposerKey, parsePullRequestComposers, type PullRequestComposer } from "../pull-request-composer-state";
import type { PullRequestWriteRequest, PullRequestWriteReceipt, PullRequestWritesBridge } from "../../../../packages/shared/src/pull-request-write";
import { PullRequestComposers } from "./pull-request-composers";

const draft: PullRequestComposer = { hostId: "host-one", accountId: "account-one", pullRequest: { hostname: "github.com", owner: "owner", repository: "repo", number: 42 }, mode: "comment", action: "comment", body: "Original body" };
const key = pullRequestComposerKey(draft), head = "a".repeat(40);
const receipt = (request: PullRequestWriteRequest): PullRequestWriteReceipt => ({ hostId: draft.hostId, request: structuredClone(request), outcome: "succeeded", message: "Submitted", url: "https://github.com/owner/repo/pull/42#issuecomment-1" });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pr-composer-")), store = new WindowStateStore(root, "original-window");
  const owner = new PullRequestComposers([], () => {});
  const snapshot = (): WindowViewState => ({ ...defaultWindowView(), pullRequestComposers: owner.drafts });
  const save = () => { const view = snapshot(); owner.committed(view); const result = store.saveView(view); if (result.error) throw new Error(result.error); owner.saved(view); };
  return { root, store, owner, snapshot, save, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test("actual window save precedes one POST; receipt save precedes clearing text, reopen has no automatic dispatch", async () => {
  const f = fixture(), calls: PullRequestWriteRequest[] = [];
  const bridge: PullRequestWritesBridge = { submit: async (_host, request) => { calls.push(request); expect(f.store.bootstrap().state?.pullRequestComposers?.[0]?.request).toEqual(request); return receipt(request); }, status: async () => null };
  try {
    f.owner.edit(draft); const operation = f.owner.submit(key, head, bridge, () => true);
    await tick(); expect(calls).toHaveLength(0); f.save(); await tick();
    expect(calls).toHaveLength(1); expect(f.owner.get(key)?.body).toBe("Original body"); expect(f.owner.busy(key)).toBe(true);
    f.save(); expect((await operation).outcome).toBe("succeeded"); expect(f.owner.get(key)?.body).toBe(""); f.save();
    const reopened = new WindowStateStore(f.root, "original-window");
    const restored = new PullRequestComposers(reopened.bootstrap().state!.pullRequestComposers!, () => {});
    expect(restored.get(key)?.receipt?.outcome).toBe("succeeded"); expect(calls).toHaveLength(1);
  } finally { f.cleanup(); }
});
test("committed original loss and persistence failure prevent dispatch even after stale save arrives", async () => {
  for (const cause of ["commit", "save", "owner"] as const) {
    const f = fixture(); let calls = 0;
    const bridge: PullRequestWritesBridge = { submit: async (_host, request) => { calls++; return receipt(request); }, status: async () => null };
    try {
      f.owner.edit(draft); const operation = f.owner.submit(key, head, bridge, () => true); const outcome = operation.then(() => ({ error: undefined }), error => ({ error }));
      const original = f.snapshot(); f.owner.committed(original);
      if (cause === "commit") f.owner.committed({ ...original, pullRequestComposers: [] });
      else if (cause === "save") f.owner.failed("Disk save failed");
      else f.owner.invalidate(key);
      f.owner.saved(original); expect((await outcome).error).toBeInstanceOf(Error); expect(calls).toBe(0); expect(f.owner.get(key)?.body).toBe(draft.body);
    } finally { f.cleanup(); }
  }
});
test("receipt-save failure retains exact request and original text; explicit status recovers without another POST", async () => {
  const f = fixture(); let calls = 0;
  const bridge: PullRequestWritesBridge = { submit: async (_host, request) => { calls++; return receipt(request); }, status: async (_host, request) => receipt(request) };
  try {
    f.owner.edit(draft); const operation = f.owner.submit(key, head, bridge, () => true), outcome = operation.then(() => ({ error: undefined }), error => ({ error }));
    f.save(); await tick(); f.owner.failed("receipt disk failed"); expect((await outcome).error?.message).toContain("disk");
    expect(f.owner.get(key)?.body).toBe(draft.body); expect(calls).toBe(1);
    // Reopen from the already persisted original request, not the unsaved memory receipt.
    const reopened = new PullRequestComposers(f.store.bootstrap().state!.pullRequestComposers!, () => {});
    expect(reopened.get(key)?.receipt).toBeUndefined();
    const inspecting = reopened.inspect(key, bridge, () => true); await tick();
    const view = { ...defaultWindowView(), pullRequestComposers: reopened.drafts }; reopened.committed(view); expect(f.store.saveView(view)).toEqual({}); reopened.saved(view);
    expect((await inspecting)?.outcome).toBe("succeeded"); expect(reopened.get(key)?.body).toBe(""); expect(calls).toBe(1);
  } finally { f.cleanup(); }
});
test("a pending original cannot be edited or silently retried; explicit acknowledgement creates a fresh request", async () => {
  const f = fixture(); let calls = 0; const ids: string[] = [];
  const bridge: PullRequestWritesBridge = { submit: async (_host, request) => { calls++; ids.push(request.requestId); return { ...receipt(request), outcome: "unknown", url: null }; }, status: async () => null };
  try {
    f.owner.edit(draft); const operation = f.owner.submit(key, head, bridge, () => true);
    expect(() => f.owner.edit({ ...draft, body: "changed" })).toThrow("Resolve");
    await expect(f.owner.submit(key, head, bridge, () => true)).rejects.toThrow("Wait");
    f.save(); await tick(); f.save(); await operation;
    await expect(f.owner.submit(key, head, bridge, () => true)).rejects.toThrow("Check");
    f.owner.startFresh(key); f.owner.edit({ ...draft, body: "deliberate fresh text" });
    const next = f.owner.submit(key, head, bridge, () => true); f.save(); await tick(); f.save(); await next;
    expect(calls).toBe(2); expect(ids[0]).not.toBe(ids[1]); expect(f.owner.get(key)?.body).toBe("deliberate fresh text");
  } finally { f.cleanup(); }
});
test("draft persistence preserves hosts, accounts, review decision, Unicode and rejects sparse or mismatched requests", () => {
  const f = fixture();
  try {
    for (const entry of [draft, { ...draft, hostId: "second-host", body: "第二段" }, { ...draft, mode: "review" as const, action: "request_changes" as const }]) f.owner.edit(entry);
    f.save(); expect(new WindowStateStore(f.root, "original-window").bootstrap().state?.pullRequestComposers).toEqual(f.owner.drafts);
    expect(() => parsePullRequestComposers(new Array(1))).toThrow();
    expect(() => parsePullRequestComposers([{ ...draft, body: "x", request: { requestId: "original-request-0001", accountId: draft.accountId, pullRequest: draft.pullRequest, action: "comment", body: "foreign", expectedHeadOid: head } }])).toThrow("text changed");
    const copy = f.owner.drafts; copy[0]!.pullRequest.owner = "mutated"; expect(f.owner.get(key)?.pullRequest.owner).toBe("owner");
  } finally { f.cleanup(); }
});
