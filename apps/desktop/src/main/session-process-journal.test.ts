import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowStateStore } from "./window-state";
import { SessionProcessJournalStore } from "./session-process-journal";
import { defaultWindowView } from "../window-state";
import { createSessionProcessesJournal } from "../renderer/session-process-journal";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const directory = () => { const value = mkdtempSync(join(tmpdir(), "process-journal-")); directories.push(value); return value; };
const scope = { hostId: "host-a", sessionId: "session-a" };
const metadata = () => ({ operationId: "operation-001", action: "input" as const,
  owner: { nativeSessionId: "native-a", epoch: "epoch-a", projectDir: "/private/project" },
  target: { brokerId: "broker-a", name: "server", id: "process-a", generation: 1 } });

test("operation identities survive layout/geometry saves and reopen, isolated by window and host/session", () => {
  const root = directory(), store = new SessionProcessJournalStore(root, "primary");
  const entries = [metadata()];
  expect(store.saveProcessOperations(scope, entries)).toEqual({});
  entries[0]!.target.generation = 900;
  expect(new WindowStateStore(root, "primary").saveView(defaultWindowView())).toEqual({});
  expect(new WindowStateStore(root, "primary").saveGeometry({ x: 1, y: 2, width: 1000, height: 800 }, false)).toEqual({});
  const reopened = new SessionProcessJournalStore(root, "primary");
  expect(reopened.readProcessOperations(scope)).toEqual({ entries: [metadata()] });
  const returned = reopened.readProcessOperations(scope).entries!;
  returned[0]!.owner.epoch = "changed";
  expect(reopened.readProcessOperations(scope)).toEqual({ entries: [metadata()] });
  expect(reopened.readProcessOperations({ ...scope, hostId: "host-b" })).toEqual({ entries: [] });
  expect(reopened.readProcessOperations({ ...scope, sessionId: "session-b" })).toEqual({ entries: [] });
  expect(new SessionProcessJournalStore(root, "other").readProcessOperations(scope)).toEqual({ entries: [] });
  expect(reopened.saveProcessOperations(scope, [])).toEqual({});
  expect(new SessionProcessJournalStore(root, "primary").readProcessOperations(scope)).toEqual({ entries: [] });
});

test("stdin, sparse, duplicate and oversized metadata are rejected before disk changes", () => {
  const store = new SessionProcessJournalStore(directory(), "primary");
  expect(store.saveProcessOperations(scope, [metadata()])).toEqual({});
  const bytes = readFileSync(store.file);
  const invalid = [[{ ...metadata(), text: "do not save this input" }], new Array(1), [metadata(), metadata()],
    Array.from({ length: 33 }, (_, index) => ({ ...metadata(), operationId: `operation-${index}` })),
    [{ ...metadata(), target: { ...metadata().target, generation: -1 } }]];
  for (const entries of invalid) {
    expect(store.saveProcessOperations(scope, entries).error).toBeTruthy();
    expect(readFileSync(store.file)).toEqual(bytes);
    expect(new SessionProcessJournalStore(join(store.file, ".."), "primary").readProcessOperations(scope)).toEqual({ entries: [metadata()] });
  }
});

test("unreadable operation records stay intact through ordinary layout and geometry writes", () => {
  const root = directory(), file = join(root, "window-primary-process-operations-v1.json");
  const raw = JSON.stringify({ version: 1, records: [{ ...scope, entries: [{ ...metadata(), text: "unexpected" }] }] });
  writeFileSync(file, raw);
  const store = new SessionProcessJournalStore(root, "primary");
  expect(store.readProcessOperations(scope).error).toMatch(/could not be read/);
  expect(new WindowStateStore(root, "primary").saveView(defaultWindowView())).toEqual({});
  expect(new WindowStateStore(root, "primary").saveGeometry({ x: 1, y: 2, width: 1000, height: 800 }, false)).toEqual({});
  expect(store.saveProcessOperations(scope, []).error).toBeTruthy();
  expect(readFileSync(file, "utf8")).toBe(raw);
  expect(new SessionProcessJournalStore(root, "primary").readProcessOperations(scope).error).toBeTruthy();
});

test("failed atomic save never acknowledges or advances in-memory operation records", () => {
  const store = new SessionProcessJournalStore(directory(), "primary");
  mkdirSync(store.file); // The owned path is a directory, so rename cannot replace it.
  expect(store.saveProcessOperations(scope, [metadata()]).error).toBeTruthy();
  expect(store.readProcessOperations(scope)).toEqual({ entries: [] });
  rmSync(store.file, { recursive: true });
  expect(store.saveProcessOperations(scope, [metadata()])).toEqual({});
});

test("renderer journal requires main acknowledgement, preserves failures and copies both directions", async () => {
  const store = new SessionProcessJournalStore(directory(), "primary");
  const bridge = { initial: {}, save: () => ({}),
    readProcessOperations: store.readProcessOperations.bind(store), saveProcessOperations: store.saveProcessOperations.bind(store) };
  const journal = createSessionProcessesJournal(bridge);
  await journal.save(scope, [metadata()]);
  expect(await createSessionProcessesJournal({ ...bridge }).load(scope)).toEqual([metadata()]);
  expect(await journal.load({ ...scope, hostId: "other" })).toEqual([]);
  await expect(createSessionProcessesJournal(undefined).save(scope, [metadata()])).rejects.toThrow("unavailable");
  await expect(createSessionProcessesJournal({ ...bridge, saveProcessOperations: () => ({ error: "disk failed" }) }).save(scope, [metadata()])).rejects.toThrow("disk failed");
  await expect(createSessionProcessesJournal({ ...bridge, readProcessOperations: () => ({}) }).load(scope)).rejects.toThrow("Invalid process operation list");
  expect(store.readProcessOperations(scope)).toEqual({ entries: [metadata()] });
});
