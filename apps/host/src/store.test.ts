import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCommand, SessionSummary } from "../../../packages/shared/src/protocol.ts";
import { HostStore, type DraftInput } from "./store.ts";
import { Database } from "bun:sqlite";

const directories: string[] = [];
const stores = new Set<HostStore>();

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-desktop-store-"));
  directories.push(path);
  return path;
}

function open(path: string): HostStore {
  const store = new HostStore(path);
  stores.add(store);
  return store;
}

function close(store: HostStore): void {
  store.close();
  stores.delete(store);
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const draft: DraftInput = { id: "new-chat", text: "first laptop's unsent work", projectId: null, model: null, thinkingLevel: "high" };

test("metadata transactions roll back nested writes together and persist complete transitions", () => {
  const root = directory(), store = open(root);
  store.writeMetadata("reset-test:a", { value: 1 });
  const db = new Database(join(root, "state.sqlite"));
  try {
    db.exec("CREATE TRIGGER fail_reset_metadata BEFORE INSERT ON metadata WHEN NEW.key = 'reset-test:b' BEGIN SELECT RAISE(ABORT, 'fixture metadata write failure'); END");
    expect(() => store.transactionMetadata(() => {
      store.writeMetadata("reset-test:a", { value: 2 });
      store.transactionMetadata(() => store.writeMetadata("reset-test:b", { value: 2 }));
    })).toThrow("fixture metadata write failure");
    expect(store.readMetadata<unknown>("reset-test:a")).toEqual({ value: 1 });
    expect(store.readMetadata("reset-test:b")).toBeUndefined();
    db.exec("DROP TRIGGER fail_reset_metadata");
    store.transactionMetadata(() => {
      store.writeMetadata("reset-test:a", { value: 2 });
      store.transactionMetadata(() => store.writeMetadata("reset-test:b", { value: 2 }));
    });
    close(store);
    const reopened = open(root);
    expect(reopened.readMetadata<unknown>("reset-test:a")).toEqual({ value: 2 });
    expect(reopened.readMetadata<unknown>("reset-test:b")).toEqual({ value: 2 });
  } finally { db.close(); }
});

test("metadata retention enumerates only its literal prefix and refuses hidden overflow", () => {
  const store = open(directory());
  store.writeMetadata("reset_test:a", 1);
  store.writeMetadata("reset_test:b", 2);
  store.writeMetadata("resetXtest:foreign", 3);
  expect(store.metadataKeys("reset_test:", 2)).toEqual(["reset_test:a", "reset_test:b"]);
  expect(() => store.metadataKeys("reset_test:", 1)).toThrow();
  expect(() => store.transactionMetadata(() => {
    store.deleteMetadata("reset_test:a");
    throw new Error("cancel retention");
  })).toThrow();
  expect(store.readMetadata<unknown>("reset_test:a")).toBe(1);
  store.transactionMetadata(() => store.deleteMetadata("reset_test:a"));
  expect(store.metadataKeys("reset_test:", 1)).toEqual(["reset_test:b"]);
  expect(store.readMetadata<unknown>("resetXtest:foreign")).toBe(3);
});

test("bounded metadata reads reject oversized retained records without changing ordinary reads", () => {
  const store = open(directory()), value = { text: "x".repeat(128) };
  store.writeMetadata("reset-test:large", value);
  expect(() => store.readMetadata("reset-test:large", 64)).toThrow();
  expect(store.readMetadata<unknown>("reset-test:large", 256)).toEqual(value);
  expect(store.readMetadata<unknown>("reset-test:large")).toEqual(value);
  expect(store.readMetadata("reset-test:absent", 64)).toBeUndefined();
});

describe("HostStore persistence and recovery", () => {
  test("permission-bearing state raises a durable rollback gate only when its write commits", () => {
    const path = directory(), store = open(path);
    const db = new Database(join(path, "state.sqlite"));
    const version = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    try {
      store.putDraft(draft, 0); expect(version()).toBe(1);
      db.exec("CREATE TRIGGER fail_permission_draft BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT, 'fixture disk write failure'); END");
      expect(() => store.putDraft({ ...draft, approvalMode: "always-ask" }, 1)).toThrow("fixture disk write failure");
      expect(version()).toBe(1); expect(store.getDraft(draft.id)?.approvalMode).toBeUndefined();
      db.exec("DROP TRIGGER fail_permission_draft");
      const conflict = store.putDraft({ ...draft, approvalMode: "always-ask" }, 0);
      expect(conflict.ok).toBe(false); expect(version()).toBe(2);
      close(store); const reopened = open(path);
      expect(version()).toBe(2);
      expect(reopened.listDraftConflicts()[0]?.attempted.approvalMode).toBe("always-ask");
      reopened.putDraft({ ...draft, approvalMode: "write" }, 1);
      expect(reopened.consumeDraft({ id: draft.id, revision: 2 })?.approvalMode).toBe("write");
      reopened.putDraft(draft, 3); expect(version()).toBe(2);
    } finally { db.close(); }
  });

  test("pending permission commands preserve intent across reopen and cannot be rewritten", () => {
    const path = directory(), first = open(path);
    const command: HostCommand = { type: "session.prompt", sessionId: "session", text: "captured unsent work", approvalMode: "always-ask" };
    first.claimCommand("permission-send", "hash", command); close(first);
    const db = new Database(join(path, "state.sqlite"));
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 }); db.close();
    const second = open(path);
    expect(second.claimCommand("permission-send", "hash", command)).toMatchObject({ kind: "pending", record: { command } });
    expect(second.claimCommand("permission-send", "newhash", { ...command, approvalMode: "yolo" }).kind).toBe("conflict");
    expect(second.getCommand("permission-send")?.command).toEqual(command);
  });

  test("reopening preserves host/project/draft/session identity and interrupts only running sessions", () => {
    const path = directory();
    const projectPath = join(path, "project");
    mkdirSync(projectPath);
    const first = open(path);
    const identity = first.host;
    const project = first.addProject({ path: projectPath, name: "Example" });
    const savedDraft = first.putDraft({ ...draft, projectId: project.id }, 0);
    const running: SessionSummary = {
      id: "native-session-id", hostId: identity.id, projectId: project.id, cwd: projectPath,
      title: "Still working", status: "running", sessionFile: join(path, "native-session.jsonl"),
      model: { provider: "test-provider", id: "test-model" }, createdAt: 1, updatedAt: 2, archived: false,
    };
    first.upsertSession(running);
    first.upsertSession({ ...running, id: "idle-session", status: "idle", archived: true });
    close(first);

    const recovered = open(path);
    expect(recovered.host).toEqual(identity);
    expect(recovered.listProjects()).toEqual([project]);
    expect(savedDraft.ok).toBe(true);
    if (savedDraft.ok) expect(recovered.getDraft(draft.id)).toEqual(savedDraft.draft);
    expect(recovered.getSession(running.id)).toMatchObject({
      id: running.id, sessionFile: running.sessionFile, status: "interrupted", model: running.model,
    });
    expect(recovered.getSession(running.id)?.error).toContain("outcome is unknown");
    expect(recovered.getSession("idle-session")).toMatchObject({ status: "idle", archived: true });
  });

  test("adding the same physical project through a symlink preserves its identity", () => {
    const path = directory();
    const projectPath = join(path, "project");
    mkdirSync(projectPath);
    symlinkSync(projectPath, join(path, "linked-project"));
    const store = open(path);
    const project = store.addProject({ path: projectPath });
    expect(store.addProject({ path: join(path, "linked-project"), name: "Another name" })).toEqual(project);
    expect(store.listProjects()).toHaveLength(1);
  });

  test("catalog removal retains existing project ownership through SQLite reopen and re-add restores it", () => {
    const path = directory(), projectPath = join(path, "project"), sessionFile = join(path, "session.jsonl");
    mkdirSync(projectPath);
    const first = open(path), project = first.addProject({ path: projectPath, name: "Before removal" });
    const savedDraft = first.putDraft({ ...draft, projectId: project.id }, 0);
    expect(savedDraft.ok).toBe(true);
    first.upsertSession({ id: "retained-session", hostId: first.host.id, projectId: project.id, cwd: project.path,
      title: "Retained", status: "idle", sessionFile, model: null, createdAt: 1, updatedAt: 1, archived: false });
    const removed = first.removeProject(project.id);
    expect(removed.removedAt).toEqual(expect.any(Number));
    expect(first.listProjects()).toEqual([]);
    expect(first.getProject(project.id)).toMatchObject({ id: project.id, path: project.path, removedAt: removed.removedAt });
    expect(first.getCataloguedProject(project.id)).toBeUndefined();
    expect(first.getSession("retained-session")?.projectId).toBe(project.id);
    expect(first.getDraft(draft.id)?.projectId).toBe(project.id);
    close(first);
    const reopened = open(path);
    expect(reopened.listProjects()).toEqual([]);
    expect(reopened.getSession("retained-session")).toMatchObject({ projectId: project.id, cwd: project.path, sessionFile });
    expect(reopened.getDraft(draft.id)?.projectId).toBe(project.id);
    expect(reopened.upsertSession({ ...reopened.getSession("retained-session")!, title: "Still admitted" }).title).toBe("Still admitted");
    const restored = reopened.addProject({ path: projectPath, name: "Restored name" });
    expect(restored).toEqual({ ...project, name: "Restored name" });
    expect(reopened.listProjects()).toEqual([restored]);
  });

  test("a stale draft write preserves both complete versions durably", () => {
    const path = directory();
    const first = open(path);
    const second = open(path);
    expect(first.putDraft(draft, 0).ok).toBe(true);
    const attempted: DraftInput = { ...draft, text: "second laptop's offline work", thinkingLevel: "low" };
    const stale = second.putDraft(attempted, 0);
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("Expected a conflict");
    expect(stale.currentDraft).toMatchObject({ ...draft, revision: 1 });
    expect(stale.conflict.attempted).toEqual(attempted);
    expect(first.getDraft(draft.id)?.text).toBe(draft.text);

    // A subsequent accepted edit must not erase the conflict's winning snapshot.
    expect(first.putDraft({ ...draft, text: "later accepted edit" }, 1).ok).toBe(true);
    close(first);
    close(second);
    const recovered = open(path);
    expect(recovered.listDraftConflicts(draft.id)).toEqual([stale.conflict]);
    expect(recovered.listDraftConflicts()[0]?.currentDraft?.text).toBe(draft.text);
    expect(recovered.getDraft(draft.id)).toMatchObject({ text: "later accepted edit", revision: 2 });
  });

  test("a stale revision for a missing draft preserves its attempted contents", () => {
    const store = open(directory());
    const result = store.putDraft(draft, 7);
    expect(result.ok).toBe(false);
    expect(store.getDraft(draft.id)).toBeUndefined();
    expect(store.listDraftConflicts()[0]).toMatchObject({ attempted: draft, expectedRevision: 7, currentDraft: null });
  });

  test("consuming a submitted draft clears only its text and preserves selections durably", () => {
    const path = directory();
    const store = open(path);
    const selected: DraftInput = { ...draft, projectId: "selected-project", model: { provider: "provider", id: "model" } };
    const saved = store.putDraft(selected, 0);
    if (!saved.ok) throw new Error("Expected the initial draft to save");
    const cleared = store.consumeDraft({ id: selected.id, revision: saved.draft.revision });
    expect(cleared).toMatchObject({ ...selected, text: "", revision: 2 });
    expect(cleared!.updatedAt).toBeGreaterThanOrEqual(saved.draft.updatedAt);
    expect(store.consumeDraft({ id: selected.id, revision: saved.draft.revision })).toBeUndefined();
    close(store);
    const recovered = open(path);
    expect(recovered.getDraft(selected.id)).toEqual(cleared);
    expect(recovered.listDraftConflicts()).toEqual([]);
  });

  test("consuming an older submitted revision preserves newer edits from another connection", () => {
    const path = directory();
    const sender = open(path);
    const editor = open(path);
    const submitted = sender.putDraft(draft, 0);
    if (!submitted.ok) throw new Error("Expected the initial draft to save");
    const newer = editor.putDraft({ ...draft, text: "next message typed during delivery", thinkingLevel: "low" }, submitted.draft.revision);
    if (!newer.ok) throw new Error("Expected the concurrent edit to save");
    expect(sender.consumeDraft({ id: draft.id, revision: submitted.draft.revision })).toBeUndefined();
    expect(sender.getDraft(draft.id)).toEqual(newer.draft);
    expect(editor.getDraft(draft.id)).toEqual(newer.draft);
    expect(sender.consumeDraft({ id: "missing", revision: 0 })).toBeUndefined();
    expect(sender.listDraftConflicts()).toEqual([]);
  });

  test("competing command claims cannot both own execution or reuse an ID for another payload", () => {
    const path = directory();
    const first = open(path);
    const second = open(path);
    expect(first.claimCommand("send-1", "hash-a").kind).toBe("claimed");
    expect(second.claimCommand("send-1", "hash-a").kind).toBe("pending");
    expect(second.claimCommand("send-1", "hash-b").kind).toBe("conflict");
    expect(() => second.finishCommand("send-1", "hash-b", { ok: true, commandId: "send-1" })).toThrow("different payload");
    const result = { ok: true as const, commandId: "send-1" };
    first.finishCommand("send-1", "hash-a", result);
    expect(second.claimCommand("send-1", "hash-a")).toMatchObject({ kind: "done", record: { state: "done", result } });
    expect(second.claimCommand("send-1", "hash-b").kind).toBe("conflict");
    // Finishing again returns the recorded outcome; it cannot overwrite it.
    expect(second.finishCommand("send-1", "hash-a", {
      ok: false, commandId: "send-1", error: { code: "LATE", message: "late result" },
    }).result).toEqual(result);
  });

  test("a process crash after claiming a command leaves it pending and never reissues it", () => {
    const path = directory();
    const storePath = new URL("./store.ts", import.meta.url).pathname;
    const command: HostCommand = {
      type: "session.prompt", sessionId: "native-session", text: "accepted work that must remain recoverable",
      model: { provider: "provider", id: "model" }, thinkingLevel: "high", approvalMode: "always-ask", draft: { id: "new-chat", revision: 4 },
    };
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { HostStore } from ${JSON.stringify(storePath)};
      const store = new HostStore(${JSON.stringify(path)});
      if (store.claimCommand("uncertain-send", "request-hash", ${JSON.stringify(command)}).kind !== "claimed") process.exit(2);
      process.kill(process.pid, "SIGKILL");
    `], { stdout: "pipe", stderr: "pipe" });
    expect(child.success).toBe(false);
    const recovered = open(path);
    expect(recovered.claimCommand("uncertain-send", "request-hash")).toMatchObject({
      kind: "pending", record: { state: "pending", result: null, command },
    });
    expect(recovered.claimCommand("uncertain-send", "changed-request", {
      ...command, text: "a retry must not replace the original command",
    }).kind).toBe("conflict");
    expect(recovered.getCommand("uncertain-send")?.command).toEqual(command);
  });

  test("completed results and ordered event cursors survive reopening", () => {
    const path = directory();
    const first = open(path);
    first.claimCommand("finished", "hash");
    const result = { ok: false as const, commandId: "finished", error: { code: "DENIED", message: "Declined" } };
    first.finishCommand("finished", "hash", result);
    const event1 = first.appendEvent({ type: "runtime", sessionId: "s1", event: { type: "start" } });
    const event2 = first.appendEvent({ type: "runtime", sessionId: "s2", event: { type: "start" } });
    const event3 = first.appendEvent({ type: "runtime", sessionId: "s1", event: { type: "stop" } });
    close(first);
    const recovered = open(path);
    expect(recovered.claimCommand("finished", "hash")).toMatchObject({ kind: "done", record: { result } });
    expect(recovered.lastEventSequence).toBe(event3.sequence);
    expect(recovered.eventsAfter(0, 1)).toEqual([event1]);
    expect(recovered.eventsAfter(event1.sequence)).toEqual([event2, event3]);
    expect(recovered.eventsAfter(event3.sequence)).toEqual([]);
    expect(recovered.appendEvent({ type: "connection", connected: true }).sequence).toBeGreaterThan(event3.sequence);
  });
});
