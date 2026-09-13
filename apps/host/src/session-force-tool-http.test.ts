import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_FORCE_TOOL_OWNER_HEADER, parseForceToolResponse, type ForceToolState } from "../../../packages/shared/src/force-tool";
import { SessionForceToolHttp, projectForceToolJournalReceipt } from "./session-force-tool-http";
import { HostStore } from "./store";

const live = (): ForceToolState => ({ epoch: "worker", revision: 1, nativeSessionId: "native", model: { provider: "local", id: "model", api: "ollama-chat" },
  availability: { state: "supported", reason: "" }, tools: [{ name: "read", available: true }], directives: [], canArm: true, canCancel: false });
const request = (suffix = "", owner = "host", method = "GET") => new Request(`http://localhost/v1/sessions/session/force-tool${suffix}`, { method, headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: owner } });

test("force status refuses wrong owners, methods, duplicate query IDs and oversized UTF8 targets before any worker read", async () => {
  let reads = 0;
  const service = new SessionForceToolHttp({ hostId: "host", sessionExists: id => id === "session", receipt: (_, commandId) => ({ commandId, state: "absent" }), existing: async () => { reads++; return undefined; } });
  expect((await service.route(request("", "other")))?.status).toBe(409);
  expect((await service.route(request("", "host", "POST")))?.status).toBe(405);
  for (const suffix of ["?commandId=", "?commandId=a&commandId=b", "?commandId=a/b", "?extra=x"])
    expect((await service.route(request(suffix)))?.status).toBe(400);
  expect((await service.route(new Request(`http://localhost/v1/sessions/${encodeURIComponent("é".repeat(101))}/force-tool`, { headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: "host" } })))?.status).toBe(400);
  expect(reads).toBe(0);
  const response = (await service.route(request("?commandId=original")))!;
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get(SESSION_FORCE_TOOL_OWNER_HEADER)).toBe("host");
  expect(parseForceToolResponse(await response.json(), "host", "session", "original")).toMatchObject({ value: null, receipt: { state: "absent", commandId: "original" } });
  expect(reads).toBe(1); // No create/open/restore capability was supplied.
});

test("missing/dead workers do not erase independent historical arms or expose native errors", async () => {
  let dead = false;
  const service = new SessionForceToolHttp({ hostId: "host", sessionExists: () => true,
    receipt: (_, commandId) => ({ commandId, state: "failed", forceToolReceipt: { commandId, epoch: "old-worker", directiveId: "old-directive", toolName: "read", arm: "armed", prompt: "not-recorded" } }),
    existing: async () => dead ? { getForceToolState: async () => { throw new Error("credential-secret"); } } : undefined });
  for (const failure of [false, true]) {
    dead = failure;
    const response = (await service.route(request("?commandId=original")))!;
    const body = await response.text(); expect(body).not.toContain("credential-secret");
    const parsed = parseForceToolResponse(JSON.parse(body), "host", "session", "original");
    expect(parsed.value).toBeNull(); expect(parsed.receipt?.forceToolReceipt?.directiveId).toBe("old-directive");
  }
});

test("journal corruption cannot discard valid live state; session disappearance wins after await", async () => {
  let exists = true;
  const service = new SessionForceToolHttp({ hostId: "host", sessionExists: () => exists,
    receipt: () => { throw new Error("journal failure"); }, existing: async () => ({ getForceToolState: async () => live() }) });
  const response = (await service.route(request("?commandId=original")))!;
  expect(parseForceToolResponse(await response.json(), "host", "session", "original")).toMatchObject({ value: { epoch: "worker" }, receipt: { state: "unknown" } });
  const disappearing = new SessionForceToolHttp({ hostId: "host", sessionExists: () => exists,
    receipt: (_, commandId) => ({ commandId, state: "absent" }), existing: async () => { exists = false; return undefined; } });
  expect((await disappearing.route(request()))?.status).toBe(409);
});

test("actual store claim dedupe retains changed-ID refusal, orphan pending and durable partial receipts without a new queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "force-journal-"));
  const store = new HostStore(root);
  try {
    const command = { type: "session.prompt" as const, sessionId: "session", text: "/force read remaining" };
    expect(store.claimCommand("original", "hash-a", command).kind).toBe("claimed");
    expect(store.claimCommand("original", "hash-a", command).kind).toBe("pending");
    expect(store.claimCommand("original", "hash-b", { ...command, text: "/force write changed" }).kind).toBe("conflict");
    expect(projectForceToolJournalReceipt(store.getCommand("original"), "session", "original", true).state).toBe("pending");
    expect(projectForceToolJournalReceipt(store.getCommand("original"), "session", "original", false).state).toBe("unknown");
    expect(projectForceToolJournalReceipt(store.getCommand("original"), "other", "original", false).state).toBe("absent");
    const forceToolReceipt = { commandId: "original", epoch: "old", directiveId: "d", toolName: "read", arm: "armed" as const, prompt: "not-recorded" as const };
    // Structural extra field remains assignable before Root exports both result arms.
    const failure = { ok: false as const, commandId: "original", error: { code: "COMMAND_FAILED", message: "pre-entry" }, forceToolReceipt };
    store.finishCommand("original", "hash-a", failure);
    expect(store.claimCommand("original", "hash-a", command).kind).toBe("done");
    expect(projectForceToolJournalReceipt(store.getCommand("original"), "session", "original", false)).toEqual({ commandId: "original", state: "failed", forceToolReceipt });
    expect(() => store.finishCommand("original", "hash-b", failure)).toThrow();
    store.claimCommand("ordinary", "hash-c", { ...command, text: "ordinary prompt" });
    store.finishCommand("ordinary", "hash-c", { ok: true, commandId: "ordinary" });
    expect(projectForceToolJournalReceipt(store.getCommand("ordinary"), "session", "ordinary", false)).toEqual({ commandId: "ordinary", state: "succeeded" });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
