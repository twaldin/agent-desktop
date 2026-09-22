import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRegistry, type AgentRef, type SessionManager } from "@oh-my-pi/pi-coding-agent";
import { assertSessionSubagentsResultMatches, parseSessionSubagentsEnvelope, parseSessionSubagentsRequest, parseSessionSubagentsResult,
  type SessionSubagentsRequest, type SessionSubagentsResult } from "../../../../packages/shared/src/session-subagents";
import { NativeSessionSubagents, nativeSubagentsErrorCode, type NativeSubagentsSession } from "./session-subagents";

const owner = { nativeSessionId: "root", epoch: "epoch" }, target = { id: "child", sessionId: "child-session", guard: "guard" };
const code = (promise: Promise<unknown>) => promise.then(() => "accepted", error => nativeSubagentsErrorCode(error) ?? String(error));

test("request parser admits only the read-only actions with exact fields and child-relative paths", () => {
  expect(parseSessionSubagentsRequest({ action: "list" })).toEqual({ action: "list" });
  expect(parseSessionSubagentsRequest({ action: "image", owner, target, nativeEntryId: "entry", blockIndex: 2, source: "generated" })).toEqual({ action: "image", owner, target, nativeEntryId: "entry", blockIndex: 2, source: "generated" });
  expect(parseSessionSubagentsRequest({ action: "file", owner, target, path: "src/./a.txt" })).toEqual({ action: "file", owner, target, path: "src/./a.txt" });
  for (const raw of [
    { action: "resume", owner, target }, { action: "list", target }, { action: "transcript", owner }, { action: "validate", owner, target, path: "x" },
    { action: "image", owner, target, nativeEntryId: "entry", blockIndex: -1 }, { action: "image", owner, target, nativeEntryId: "entry", blockIndex: 0, source: "input" },
    { action: "file", owner, target, path: "/etc/passwd" }, { action: "file", owner, target, path: "../secret" }, { action: "file", owner, target, path: "a/..\\b" }, { action: "file", owner, target, path: "" },
    { action: "file", owner, target, path: "C:\\x" }, { action: "transcript", owner: { ...owner, agentId: "Main" }, target },
  ]) expect(() => parseSessionSubagentsRequest(raw), JSON.stringify(raw)).toThrow(/Invalid native subagents/);
});

test("result parser enforces availability shapes, bounded rows, image integrity and answered identity", () => {
  const row = { target, displayName: "child", status: "parked" as const, running: false, createdAt: 1, lastActivity: 2 };
  expect(parseSessionSubagentsResult({ action: "list", owner, availability: "available", rows: [row], omitted: 3 })).toEqual({ action: "list", owner, availability: "available", rows: [row], omitted: 3 });
  expect(() => parseSessionSubagentsResult({ action: "list", owner, availability: "unavailable", rows: [row], omitted: 0, reason: "x" })).toThrow(/unavailable rows/);
  expect(() => parseSessionSubagentsResult({ action: "list", owner, availability: "available", rows: [row, row], omitted: 0 })).toThrow(/duplicate row/);
  expect(() => parseSessionSubagentsResult({ action: "list", owner, availability: "available", rows: [{ ...row, status: "completed" }], omitted: 0 })).toThrow(/status/);
  expect(() => parseSessionSubagentsResult({ action: "list", owner, availability: "available", rows: [{ ...row, running: true }], omitted: 0 })).toThrow(/running state/);
  expect(parseSessionSubagentsResult({ action: "transcript", owner, target, availability: "missing", messages: [], truncated: false, reason: "gone" })).toMatchObject({ availability: "missing", reason: "gone" });
  expect(() => parseSessionSubagentsResult({ action: "transcript", owner, target, availability: "missing", messages: [{ id: "m", role: "user", text: "" }], truncated: false, reason: "gone" })).toThrow(/missing transcript/);
  const pixel = Buffer.from("89504e470d0a1a0a", "hex");
  const image = { base64: pixel.toString("base64"), mimeType: "image/png", bytes: pixel.byteLength, sha256: "a".repeat(64) };
  expect(parseSessionSubagentsResult({ action: "image", owner, target, image })).toEqual({ action: "image", owner, target, image: { ...image, mimeType: "image/png" } });
  expect(() => parseSessionSubagentsResult({ action: "image", owner, target, image: { ...image, bytes: 3 } })).toThrow(/image size/);
  expect(() => parseSessionSubagentsResult({ action: "image", owner, target, image: { ...image, mimeType: "image/svg+xml" } })).toThrow(/image type/);
  expect(() => parseSessionSubagentsResult({ action: "file", owner, target, path: "../x", text: "", truncated: false })).toThrow(/file path/);
  const validate: SessionSubagentsResult = { action: "validate", owner, target };
  expect(parseSessionSubagentsEnvelope({ protocolVersion: 1, hostId: "host", sessionId: "root", result: validate }, "host", "root").result).toEqual(validate);
  expect(() => parseSessionSubagentsEnvelope({ protocolVersion: 1, hostId: "host", sessionId: "other", result: validate }, "host", "root")).toThrow(/envelope owner/);
  expect(() => parseSessionSubagentsEnvelope({ protocolVersion: 1, hostId: "host", sessionId: "other", result: validate }, "host", "other")).toThrow(/native owner/);
  const request: SessionSubagentsRequest = { action: "file", owner, target, path: "a.txt" };
  expect(() => assertSessionSubagentsResultMatches(request, validate)).toThrow(/result action/);
  expect(() => assertSessionSubagentsResultMatches(request, { action: "file", owner: { ...owner, epoch: "other" }, target, path: "a.txt", text: "", truncated: false })).toThrow(/result owner/);
  expect(() => assertSessionSubagentsResultMatches(request, { action: "file", owner, target: { ...target, guard: "other" }, path: "a.txt", text: "", truncated: false })).toThrow(/result target/);
  expect(() => assertSessionSubagentsResultMatches(request, { action: "file", owner, target, path: "b.txt", text: "", truncated: false })).toThrow(/result path/);
});

test("adapter lists only registry refs whose journal lies below the original root, identifies detached rows by their journal header, and fails closed on owner change", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-subagents-adapter-")));
  const registry = AgentRegistry.global(), unique = `t${Date.now().toString(36)}`;
  const registered: AgentRef[] = [];
  const register = (id: string, sessionFile: string | null, kind: AgentRef["kind"] = "sub") => {
    const ref = registry.register({ id: `${unique}-${id}`, displayName: id, kind, parentId: "Main", session: null, sessionFile, status: "parked" });
    registered.push(ref); return ref;
  };
  try {
    const rootFile = path.join(root, "sessions", "root.jsonl"), rootDir = path.join(root, "sessions", "root");
    const foreignFile = path.join(root, "sessions", "foreign.jsonl"), foreignDir = path.join(root, "sessions", "foreign");
    await mkdir(rootDir, { recursive: true }); await mkdir(foreignDir, { recursive: true });
    const journal = (id: string, cwd = root) => `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`;
    await writeFile(rootFile, journal("root-session")); await writeFile(foreignFile, journal("foreign-session"));
    await writeFile(path.join(rootDir, "owned.jsonl"), journal("owned-session"));
    await writeFile(path.join(foreignDir, "foreign-child.jsonl"), journal("foreign-child-session"));
    await symlink(path.join(foreignDir, "foreign-child.jsonl"), path.join(rootDir, "escape.jsonl"));
    await writeFile(path.join(rootDir, "prefix.jsonl"), "not a session header\n");
    register("owned", path.join(rootDir, "owned.jsonl"));
    register("nested", path.join(rootDir, "owned", "nested.jsonl"));
    register("absent", path.join(rootDir, "absent.jsonl"));
    register("escape", path.join(rootDir, "escape.jsonl"));
    register("prefix", path.join(rootDir, "prefix.jsonl"));
    register("foreign-child", path.join(foreignDir, "foreign-child.jsonl"));
    register("sibling", path.join(root, "sessions", "root-other", "x.jsonl"));
    register("memory", null);
    register("main-like", path.join(rootDir, "main.jsonl"), "main");
    const state = { sessionFile: rootFile as string | undefined, disposed: false, retired: false };
    const session = { get sessionFile() { return state.sessionFile; }, get isDisposed() { return state.disposed; }, getAgentId: () => "Main",
      sessionManager: { getSessionId: () => "root-session" } as unknown as SessionManager } satisfies NativeSubagentsSession;
    const adapter = new NativeSessionSubagents(session, () => { if (state.retired) throw new Error("retired"); }, "root-session");
    const activity = adapter.activity();
    expect(activity.availability).toBe("available");
    if (activity.availability !== "available") throw new Error("unreachable");
    expect(activity.value.map(agent => agent.id).sort()).toEqual([`${unique}-absent`, `${unique}-escape`, `${unique}-nested`, `${unique}-owned`, `${unique}-prefix`].sort());
    const list = await adapter.request({ action: "list", owner: adapter.owner });
    if (list.action !== "list" || list.availability !== "available") throw new Error("list unavailable");
    expect(list.rows.map(row => [row.target.id, row.target.sessionId, row.status])).toEqual([[`${unique}-owned`, "owned-session", "parked"]]);
    // Absent, header-less, nested-but-absent and symlink-escaping journals are counted, never guessed or listed under another root's identity.
    expect(list.omitted).toBe(4);
    const owned = list.rows[0]!.target;
    await expect(adapter.request({ action: "validate", owner: adapter.owner, target: owned })).resolves.toEqual({ action: "validate", owner: adapter.owner, target: owned });
    const transcript = await adapter.request({ action: "transcript", owner: adapter.owner, target: owned });
    expect(transcript).toEqual({ action: "transcript", owner: adapter.owner, target: owned, availability: "available", messages: [], cwd: root, truncated: false });
    expect(await code(adapter.request({ action: "transcript", owner: adapter.owner, target: { ...owned, sessionId: "foreign-child-session" } }))).toBe("STALE_CHILD");
    expect(await code(adapter.request({ action: "transcript", owner: adapter.owner, target: { ...owned, id: `${unique}-foreign-child` } }))).toBe("STALE_CHILD");
    expect(await code(adapter.request({ action: "transcript", owner: adapter.owner, target: { ...owned, id: `${unique}-escape` } }))).toBe("STALE_CHILD");
    expect(await code(adapter.request({ action: "transcript", owner: { ...adapter.owner, epoch: "other" }, target: owned }))).toBe("STALE_OWNER");
    expect(await code(adapter.request({ action: "file", owner: adapter.owner, target: owned, path: "../x" }))).toBe("SUBAGENTS_REJECTED");
    const pendingOwnerRead = adapter.request({ action: "transcript", owner: adapter.owner, target: owned });
    state.retired = true;
    expect(await code(pendingOwnerRead)).toBe("STALE_OWNER");
    state.retired = false;
    // The guard follows the ref's generation: a re-registered id is a different child.
    const pendingChildRead = adapter.request({ action: "transcript", owner: adapter.owner, target: owned });
    registry.unregister(`${unique}-owned`);
    register("owned", path.join(rootDir, "owned.jsonl"));
    expect(await code(pendingChildRead)).toBe("STALE_CHILD");
    expect(await code(adapter.request({ action: "validate", owner: adapter.owner, target: owned }))).toBe("STALE_CHILD");
    const relisted = await adapter.request({ action: "list", owner: adapter.owner });
    if (relisted.action !== "list") throw new Error("unreachable");
    expect(relisted.rows[0]!.target).toMatchObject({ id: owned.id, sessionId: owned.sessionId });
    expect(relisted.rows[0]!.target.guard).not.toBe(owned.guard);
    const originalHeader = await readFile(rootFile);
    await rename(rootFile, `${rootFile}.original`);
    await writeFile(rootFile, originalHeader);
    expect(await code(adapter.request({ action: "validate", owner: adapter.owner, target: relisted.rows[0]!.target }))).toBe("STALE_OWNER");
    await rm(rootFile); await rename(`${rootFile}.original`, rootFile);
    state.sessionFile = foreignFile;
    expect(await code(adapter.request({ action: "list" }))).toBe("STALE_OWNER");
    state.sessionFile = rootFile; state.retired = true;
    expect(await code(adapter.request({ action: "list" }))).toBe("STALE_OWNER");
    expect(adapter.activity().availability).toBe("available");
    expect(await code(adapter.request({ action: "list", owner: { ...adapter.owner, epoch: "x" } }))).toBe("STALE_OWNER");
    expect(await code(adapter.request({ action: "stop" } as unknown as SessionSubagentsRequest))).toBe("SUBAGENTS_REJECTED");
  } finally {
    for (const ref of registered) registry.unregister(ref.id, ref);
    for (const id of registered.map(ref => ref.id)) registry.unregister(id);
    await rm(root, { recursive: true, force: true });
  }
});
