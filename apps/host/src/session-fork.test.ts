import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@agent-desktop/shared";
import { HostStore } from "./store";
import { sessionForkIntentKey, type SessionForkIntent } from "./session-fork";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function bindingFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fork-binding-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let store = new HostStore(root);
  cleanup.push(() => store.close());
  const source: SessionSummary = { id: "source", hostId: store.host.id, projectId: null, cwd: root, title: "Original",
    status: "idle", sessionFile: join(root, "source.jsonl"), model: null, createdAt: 1, updatedAt: 2, archived: false };
  store.upsertSession(source);
  store.putDraft({ id: "session:source", text: "Unsent original draft", projectId: null, model: null, thinkingLevel: "high" }, 0);
  store.claimCommand("fork-command", "fork-request", { type: "session.fork", sessionId: source.id, expectedRevision: "a".repeat(64), execution: { type: "local" } });
  const child: SessionSummary = { ...source, id: "child", sessionFile: join(root, "child.jsonl"), createdAt: 3, updatedAt: 3 };
  // Store boundary input: the worker's closed native-copy receipt has already been persisted.
  const intent: SessionForkIntent = { version: 1, commandId: "fork-command", source, execution: { type: "local" },
    state: "binding", targetFile: child.sessionFile, targetCwd: child.cwd, selectedEnvironment: null, child };
  store.writeMetadata(sessionForkIntentKey(source.id), intent);
  return { root, source, child, intent, get store() { return store; }, reopen() { store.close(); store = new HostStore(root); } };
}

test("binding creates an empty child composer without consuming the original and replay never erases later child edits", () => {
  const fixture = bindingFixture(), { source, child, intent, store } = fixture;
  const originalDraft = store.getDraft("session:source");
  const first = store.finishSessionFork("fork-command", intent);
  expect(first).toMatchObject({ ok: true, commandId: "fork-command", value: { type: "session.forked", commandId: "fork-command", sourceSessionId: source.id, session: child } });
  expect(store.getSession(source.id)).toEqual(source);
  expect(store.getDraft("session:source")).toEqual(originalDraft);
  const empty = store.getDraft("session:child")!;
  expect(empty.text).toBe("");
  expect(empty.attachments ?? []).toEqual([]);
  const edited = store.putDraft({ id: empty.id, text: "New child work", projectId: null, model: null }, empty.revision);
  expect(edited.ok).toBe(true);
  expect(store.finishSessionFork("fork-command", intent)).toEqual(first);
  expect(store.getDraft(empty.id)?.text).toBe("New child work");
  expect(store.getDraft("session:source")).toEqual(originalDraft);
});

test("a receipt write failure rolls back child binding and resumes only the recorded child after reopening", () => {
  const fixture = bindingFixture(), before = fixture.store.getDraft("session:source");
  const database = new Database(join(fixture.root, "state.sqlite"));
  try {
    database.exec("CREATE TRIGGER fail_fork_receipt BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'owned receipt failure'); END");
    expect(() => fixture.store.finishSessionFork("fork-command", fixture.intent)).toThrow("owned receipt failure");
    expect(fixture.store.getSession(fixture.child.id)).toBeUndefined();
    expect(fixture.store.getDraft("session:child")).toBeUndefined();
    expect(fixture.store.getCommand("fork-command")?.state).toBe("pending");
    expect(fixture.store.readMetadata<SessionForkIntent>(sessionForkIntentKey("source"))?.state).toBe("binding");
    expect(fixture.store.getDraft("session:source")).toEqual(before);
    database.exec("DROP TRIGGER fail_fork_receipt");
  } finally { database.close(); }
  fixture.reopen();
  fixture.store.claimCommand("resume-command", "resume-request", { type: "session.fork.resume", sessionId: "source", operationId: "fork-command" });
  const result = fixture.store.finishSessionFork("resume-command", fixture.intent);
  expect(result).toMatchObject({ ok: true, commandId: "resume-command", value: { type: "session.forked", commandId: "fork-command", session: fixture.child } });
  expect(fixture.store.getCommand("fork-command")?.result).toMatchObject({ ok: true, commandId: "fork-command", value: { type: "session.forked", session: fixture.child } });
  expect(fixture.store.listSessions().map(session => session.id).sort()).toEqual(["child", "source"]);
  expect(fixture.store.getDraft("session:child")?.text).toBe("");
  expect(fixture.store.getDraft("session:source")).toEqual(before);
});
