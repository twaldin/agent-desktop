import { afterEach, expect, test } from "bun:test";
import type { DraftBrowserBridge, DraftBrowserOwnerSnapshot } from "@agent-desktop/shared";
import type { DraftBrowserWindowIntent } from "../draft-browser-window-intent";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { DraftController } from "./drafts";
import { DraftBrowserWindowOwner } from "./draft-browser-window-owner";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const original: DraftBrowserWindowIntent = { version: 1, hostId: "host", reference: { ownerId: "original", draftId: "new-conversation", draftRevision: 1 } };
const invalidViews: [string, unknown][] = [
  ["dropped", []], ["missing", undefined],
  ["malformed", [{ ...original, version: 2 }]],
  ["rebound", [{ ...original, reference: { ...original.reference, draftRevision: 2 } }]],
];

function fixture(restored: DraftBrowserWindowIntent[]) {
  const calls: { operation: string; hostId: string; ownerId: string }[] = [];
  let saves = 0;
  const drafts = new DraftController(async envelope => {
    saves++;
    if (envelope.command.type !== "draft.put") throw new Error("Unexpected submission");
    return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: 1 } };
  }, "host");
  drafts.setConnected(true);
  const snapshot = (ownerId: string, state: "absent" | "ready"): DraftBrowserOwnerSnapshot => ({ protocolVersion: 1, hostId: "host", ownerId, state,
    ...(state === "ready" ? { workerPid: 55 } : {}), ticket: { controlEpoch: "epoch", observedAt: 1 } });
  const bridge: Pick<DraftBrowserBridge, "acquire" | "status" | "metadata"> = {
    status: async (ref, hostId) => { calls.push({ operation: "status", hostId, ownerId: ref.ownerId }); return snapshot(ref.ownerId, "absent"); },
    acquire: async (ref, hostId) => { calls.push({ operation: "acquire", hostId, ownerId: ref.ownerId }); return snapshot(ref.ownerId, "ready"); },
    metadata: async (ref, hostId) => { calls.push({ operation: "metadata", hostId, ownerId: ref.ownerId }); return { protocolVersion: 1, ownerKind: "draft", hostId, ownerId: ref.ownerId, availability: "running", workerPid: 55, tabs: [] }; },
  };
  const owner = new DraftBrowserWindowOwner(bridge, restored, () => {});
  owner.commit({ drafts, draftId: "new-conversation", connected: true, enabled: true });
  const view = (): WindowViewState => ({ ...defaultWindowView(), draftBrowserOwners: owner.intents });
  owner.committed(view()); owner.saved(view());
  cleanup.push(() => { owner.dispose(); drafts.dispose(); });
  return { owner, calls, view, saves: () => saves };
}

for (const [name, owners] of invalidViews) test(`late saved owner cannot recover a ${name} committed list`, async () => {
  const f = fixture([original]), saved = f.view();
  f.owner.committed({ ...saved, draftBrowserOwners: owners } as WindowViewState);
  f.owner.saved(saved);
  // Exercise both entry points even on the old implementation: its stale
  // checkpoint admits the explicit acquire after the read-only absent result.
  const inspect = await f.owner.inspect("original").then(() => "allowed", () => "blocked");
  const acquire = await f.owner.acquire().then(() => "allowed", () => "blocked");
  expect(f.calls).toEqual([]);
  expect([inspect, acquire]).toEqual(["blocked", "blocked"]);
  expect(f.owner.error).toBeDefined();
  expect(f.owner.intents).toEqual([original]);
  expect(f.saves()).toBe(0);
  expect(f.owner.attachmentGuard("original")()).toBe(false);

  // Restoring the committed projection alone is not a successful save.
  f.owner.committed(saved);
  await expect(f.owner.inspect("original")).rejects.toThrow();
  f.owner.saved(saved);
  expect(f.owner.error).toBeUndefined();
  expect(f.calls).toEqual([]);
  await f.owner.acquire(); // Restored unknown is never replayed automatically.
  expect(f.calls).toEqual([]);
  expect((await f.owner.inspect("original")).status).toBe("absent");
  expect(f.calls.map(call => call.operation)).toEqual(["status"]);
  expect((await f.owner.acquire()).status).toBe("ready");
  expect(f.calls).toEqual(["status", "acquire", "metadata"].map(operation => ({ operation, hostId: "host", ownerId: "original" })));
  expect(f.owner.intents).toEqual([original]);
  expect(f.saves()).toBe(0);
  expect(f.owner.attachmentGuard("original")()).toBe(true);
});

for (const [name, owners] of invalidViews) test(`pending acquisition is cancelled by ${name} projection before a late acknowledgement`, async () => {
  const f = fixture([]), pending = f.owner.acquire();
  await tick();
  const saved = f.view(), retained = saved.draftBrowserOwners!;
  f.owner.committed(saved);
  // Rebind to this newly allocated identity, rather than a different owner.
  const bad = name === "rebound" ? [{ ...retained[0]!, reference: { ...retained[0]!.reference, draftRevision: 2 } }] : owners;
  f.owner.committed({ ...saved, draftBrowserOwners: bad } as WindowViewState);
  f.owner.saved(saved);
  expect((await pending).status).toBe("unknown");
  expect(f.calls).toEqual([]);
  expect(f.owner.intents).toEqual(retained);
  expect(f.saves()).toBe(1);
  await expect(f.owner.inspect(retained[0]!.reference.ownerId)).rejects.toThrow();
  f.owner.committed(saved); f.owner.saved(saved);
  expect(f.calls).toEqual([]);
  await f.owner.acquire();
  expect(f.calls).toEqual([]);
  expect((await f.owner.inspect(retained[0]!.reference.ownerId)).status).toBe("absent");
  expect((await f.owner.acquire()).status).toBe("ready");
  expect(f.calls).toEqual(["status", "acquire", "metadata"].map(operation => ({ operation, hostId: "host", ownerId: retained[0]!.reference.ownerId })));
  expect(f.saves()).toBe(1);
});
