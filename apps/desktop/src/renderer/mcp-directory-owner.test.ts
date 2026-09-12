import { expect, test } from "bun:test";
import type { McpOwnerRequest, McpOwnerResult, McpOwnerSnapshot } from "@agent-desktop/shared";
import { McpDirectoryOwner } from "./mcp-directory-owner";
const catalogue = { epoch: "catalogue", revision: 1, available: true, canOpenApps: true, servers: [] };
function fixture() {
  const calls: Array<{ host: string; request: McpOwnerRequest }> = [];
  let dispatch = async (request: McpOwnerRequest): Promise<McpOwnerResult> => request.type === "retire" || request.type === "close" ? { closed: true }
    : { ownerId: request.ownerId, epoch: "original", cwd: "/original", projectId: null, catalogue, interactions: [] };
  const owner = new McpDirectoryOwner({ request: async (host, request) => { calls.push({ host, request }); return dispatch(request); } }, "host-a", null);
  owner.connected(true);
  return { owner, calls, change(value: typeof dispatch) { dispatch = value; } };
}
test("pending native startup exposes its real interaction and later catalogue without a second acquisition", async () => {
  const { owner, calls, change } = fixture(); let answered = false;
  change(async request => {
    if (request.type === "retire") return { closed: true };
    if (request.type === "answer") { expect(request.interactionId).toBe("permission-a"); expect(request.response).toEqual({ value: "Approve" }); answered = true; }
    return { ownerId: request.ownerId, epoch: "original", cwd: "/original", projectId: null,
      catalogue: answered ? catalogue : { ...catalogue, available: false, canOpenApps: false, reason: "Native startup pending" },
      interactions: answered ? [] : [{ id: "permission-a", sessionId: request.ownerId, method: "select", title: "Native permission", createdAt: 1, options: [{ label: "Approve" }], actions: [] }] };
  });
  const initial = await owner.acquire(); expect(initial.catalogue.available).toBe(false); expect(owner.snapshot?.interactions).toHaveLength(1);
  const reading = owner.catalogue("/original", new AbortController().signal);
  await owner.respond("permission-a", { value: "Approve" });
  expect((await reading).available).toBe(true); expect(owner.snapshot?.interactions).toEqual([]);
  expect(calls.filter(call => call.request.type === "acquire")).toHaveLength(1); expect(calls.every(call => call.host === "host-a")).toBe(true);
  await owner.dispose();
});
test("a cancelled app waiting on discovery does not dispatch a channel or retire sibling directory ownership", async () => {
  const { owner, calls, change } = fixture();
  change(async request => request.type === "retire" ? { closed: true } : { ownerId: request.ownerId, epoch: "original", cwd: "/original", projectId: null, catalogue: { ...catalogue, available: false, canOpenApps: false }, interactions: [] });
  await owner.acquire(); const abort = new AbortController(), waiting = owner.catalogue("/original", abort.signal); void waiting.catch(() => {});
  abort.abort(new Error("Original app closed")); await expect(waiting).rejects.toThrow("Original app closed");
  expect(owner.current()).toBe(true); expect(calls.map(call => call.request.type)).toEqual(["acquire"]); await owner.dispose();
});
test("offline loss cannot publish a held original read into a deliberate new directory owner", async () => {
  const { owner, calls, change } = fixture(); const first = await owner.acquire(), gate = Promise.withResolvers<McpOwnerResult>();
  change(async request => request.type === "read" ? gate.promise : request.type === "retire" ? { closed: true } : { ownerId: request.ownerId, epoch: "fresh", cwd: "/original", projectId: null, catalogue, interactions: [] });
  const reading = owner.refresh(); await Bun.sleep(0); owner.connected(false); owner.connected(true);
  const fresh = await owner.acquire(); expect(fresh.ownerId).not.toBe(first.ownerId);
  gate.resolve({ ...first, catalogue: { ...catalogue, revision: 999 } }); await reading;
  expect(owner.snapshot?.ownerId).toBe(fresh.ownerId); expect(owner.snapshot?.catalogue.revision).toBe(1);
  expect(calls.filter(call => call.request.type === "retire").map(call => call.request.ownerId)).toEqual([first.ownerId]); await owner.dispose();
});
test("failed disconnect remains visible and retry retires the same owner before a new acquisition", async () => {
  const { owner, calls, change } = fixture(); const first = await owner.acquire(); let fail = true;
  change(async request => { if (request.type === "retire") { if (fail) throw new Error("Original cleanup failed"); return { closed: true }; }
    return { ...first, ownerId: request.ownerId, epoch: "fresh" }; });
  await expect(owner.disconnect()).rejects.toThrow("Original cleanup failed"); expect(owner.error).toBe("Original cleanup failed"); expect(owner.current()).toBe(false);
  fail = false; const fresh = await owner.acquire(); expect(fresh.ownerId).not.toBe(first.ownerId);
  expect(calls.map(call => call.request.type)).toEqual(["acquire", "retire", "retire", "acquire"]); await owner.dispose();
});
