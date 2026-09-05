import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { PreferencesStore } from "./store";
import {
  PREFERENCE_LIMITS, THEME_TOKEN_DEFINITIONS, comparePreferenceRevisions, parsePreferenceChange, parsePreferencesSnapshot, parseThemeTokens,
  type PreferenceChange, type PreferenceRecord, type PreferencesSnapshot,
} from "../../../../packages/shared/src/preferences";

const directories: string[] = [];
const connections: HostStore[] = [];
afterEach(() => { for (const store of connections.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function connection(directory: string) { const host = new HostStore(directory); connections.push(host); return { host, preferences: new PreferencesStore(host), directory }; }
function replica() { const directory = mkdtempSync(join(tmpdir(), "agent-desktop-preferences-")); directories.push(directory); return connection(directory); }
function close(host: HostStore) { host.close(); connections.splice(connections.indexOf(host), 1); }
const snapshot = (...records: PreferenceRecord[]): PreferencesSnapshot => ({ version: 1, records });

describe("durable shared app preferences", () => {
  test("two SQLite connections share one actor/clock and reopen without resetting revisions", () => {
    const first = replica();
    const second = connection(first.directory);
    expect(first.preferences.snapshot()).toEqual({ version: 1, records: [] });
    const mode = first.preferences.put({ key: "theme.mode", value: "dark" });
    const notification = second.preferences.put({ key: "general.notifications", value: { turnComplete: true, approvalRequired: true, sound: false } });
    expect(mode.revision).toMatchObject({ counter: 1, actor: first.host.host.id });
    expect(notification.revision).toMatchObject({ counter: 2, actor: first.host.host.id });
    expect(mode.revision.opId).not.toBe(notification.revision.opId);
    expect(second.preferences.snapshot()).toEqual(first.preferences.snapshot());
    const before = first.preferences.snapshot();
    const actor = first.host.host.id;
    close(first.host); close(second.host);
    const reopened = connection(first.directory);
    expect(reopened.host.host.id).toBe(actor);
    expect(reopened.preferences.snapshot()).toEqual(before);
    expect(reopened.preferences.put({ key: "general.reduceMotion", value: true }).revision).toMatchObject({ counter: 3, actor });
  });

  test("three partitioned stores converge for every arrival order and duplicate delivery", () => {
    const peers = [replica(), replica(), replica()];
    const modes = ["light", "dark", "system"] as const;
    const proposals = peers.map((peer, index) => peer.preferences.put({ key: "theme.mode", value: modes[index]! }));
    peers[0]!.preferences.put({ key: "theme.tokens", value: { "--radius": "12px", "--ui-font": "system-ui" } });
    peers[1]!.preferences.put({ key: "general.reduceMotion", value: true });
    peers[2]!.preferences.put({ key: "general.sendBehavior", value: "mod-enter" });
    const partitions = peers.map(peer => peer.preferences.snapshot());
    const winner = [...proposals].sort((a, b) => comparePreferenceRevisions(a.revision, b.revision)).at(-1)!;
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const results = orders.map(order => {
      const destination = replica();
      for (const index of order) destination.preferences.merge(partitions[index]);
      for (const partition of partitions) expect(destination.preferences.merge(partition).changedKeys).toEqual([]);
      expect(destination.preferences.get("theme.mode")).toEqual(winner);
      expect(destination.preferences.snapshot().records).toHaveLength(4);
      return destination.preferences.snapshot();
    });
    for (const result of results) expect(result).toEqual(results[0]);
    for (const peer of peers) {
      for (const partition of partitions) peer.preferences.merge(partition);
      expect(peer.preferences.snapshot()).toEqual(results[0]);
    }
    const change = peers[0]!.preferences.put({ key: "theme.mode", value: "light" });
    expect(change.revision.counter).toBe(3);
    peers[1]!.preferences.merge(peers[0]!.preferences.snapshot());
    expect(peers[1]!.preferences.get("theme.mode")).toEqual(change);
  });

  test("concurrent sidebar deletion wins deterministically, persists and cannot be resurrected by an old snapshot", () => {
    const peers = [replica(), replica()].sort((a, b) => a.host.host.id < b.host.host.id ? -1 : 1);
    const [editor, remover] = peers as [ReturnType<typeof replica>, ReturnType<typeof replica>];
    const observer = replica();
    const sectionId = crypto.randomUUID();
    const key = `sidebar.section.${sectionId}` as const;
    const original = editor.preferences.put({ key, value: { name: "Projects", position: 1 } });
    const oldSnapshot = editor.preferences.snapshot();
    remover.preferences.merge(oldSnapshot); observer.preferences.merge(oldSnapshot);
    const edited = editor.preferences.put({ key, value: { name: "Offline rename", position: 2 } });
    const deleted = remover.preferences.put({ key, deleted: true });
    expect(edited.revision.counter).toBe(2);
    expect(deleted.revision.counter).toBe(2);
    expect(comparePreferenceRevisions(deleted.revision, edited.revision)).toBe(1);
    editor.preferences.merge(remover.preferences.snapshot());
    remover.preferences.merge(editor.preferences.snapshot());
    observer.preferences.merge(snapshot(edited)); observer.preferences.merge(snapshot(deleted));
    for (const peer of [...peers, observer]) {
      expect(peer.preferences.get(key)).toEqual(deleted);
      expect(peer.preferences.merge(snapshot(original)).changedKeys).toEqual([]);
    }
    close(observer.host);
    const reopened = connection(observer.directory);
    expect(reopened.preferences.get(key)).toEqual(deleted);
    expect(reopened.preferences.merge(oldSnapshot).changedKeys).toEqual([]);
    const restored = reopened.preferences.put({ key, value: { name: "Explicitly restored", position: 3 } });
    expect(restored.revision.counter).toBe(3);
    editor.preferences.merge(reopened.preferences.snapshot());
    expect(editor.preferences.get(key)).toEqual(restored);
  });

  test("sidebar organization carries only identities and leaves project/draft state alone", () => {
    const source = replica(); const destination = replica();
    const projectId = crypto.randomUUID(); const sessionId = crypto.randomUUID(); const sectionId = crypto.randomUUID();
    source.preferences.put({ key: `sidebar.section.${sectionId}`, value: { name: "Current work", position: 1 } });
    source.preferences.put({ key: `sidebar.project.${projectId}`, value: { hostId: source.host.host.id, sectionId, position: 4 } });
    source.preferences.put({ key: `sidebar.session.${sessionId}`, value: { hostId: source.host.host.id, sectionId: "pinned", position: 0 } });
    source.host.putDraft({ id: "unsent", text: "Private unsent work", projectId: null, model: null }, 0);
    destination.preferences.merge(source.preferences.snapshot());
    expect(destination.preferences.snapshot()).toEqual(source.preferences.snapshot());
    expect(destination.host.listProjects()).toEqual([]);
    expect(destination.host.listSessions()).toEqual([]);
    expect(destination.host.listDrafts()).toEqual([]);
    expect(JSON.stringify(destination.preferences.snapshot())).not.toContain("Private unsent work");
  });

  test("invalid or equivocated batches fail atomically and cannot advance the durable clock", () => {
    const peer = replica(); const other = replica();
    const original = peer.preferences.put({ key: "theme.mode", value: "light" });
    const independent = other.preferences.put({ key: "general.reduceMotion", value: true });
    const before = peer.host.readPreferencesState();
    const changedOriginal = { ...original, value: "dark" };
    expect(() => peer.preferences.merge(snapshot(independent, changedOriginal as PreferenceRecord))).toThrow("reused with different contents");
    expect(peer.host.readPreferencesState()).toEqual(before);
    expect(() => peer.preferences.merge({ version: 1, records: [independent, { ...original, key: "native.omp.apiKey" }] })).toThrow();
    expect(peer.host.readPreferencesState()).toEqual(before);
    expect(() => peer.preferences.merge({ version: 2, records: [] })).toThrow("schema version");
    expect(() => peer.preferences.merge(snapshot(original, original))).toThrow("duplicate keys");
    expect(() => peer.preferences.merge({ version: 1, records: [changedOriginal], unexpected: true })).toThrow("Unknown preference fields");
    expect(peer.preferences.put({ key: "theme.mode", value: "dark" }).revision.counter).toBe(2);
  });

  test("operation ids break revision ties without depending on object field order", () => {
    const source = replica(); const first = replica(); const second = replica();
    const original = source.preferences.put({ key: "theme.tokens", value: { "--radius": "8px", "--text": "#fff" } });
    const reordered = { revision: { opId: original.revision.opId, actor: original.revision.actor, counter: original.revision.counter }, deleted: false, value: { "--text": "#fff", "--radius": "8px" }, key: original.key };
    source.preferences.merge({ version: 1, records: [reordered] });
    const low: PreferenceRecord = { ...original, revision: { ...original.revision, opId: "00000000-0000-0000-0000-000000000001" } };
    const high: PreferenceRecord = { ...original, value: { "--radius": "20px" }, revision: { ...original.revision, opId: "00000000-0000-0000-0000-000000000002" } } as PreferenceRecord;
    first.preferences.merge(snapshot(low)); first.preferences.merge(snapshot(high));
    second.preferences.merge(snapshot(high)); second.preferences.merge(snapshot(low));
    expect(first.preferences.snapshot()).toEqual(second.preferences.snapshot());
    expect(first.preferences.get("theme.tokens")).toEqual(high);
  });

  test("returned objects cannot mutate persisted records and unsafe counters do not wrap", () => {
    const peer = replica();
    const initial = peer.preferences.put({ key: "theme.mode", value: "dark" });
    initial.revision.counter = 40;
    expect(peer.preferences.get("theme.mode")?.revision.counter).toBe(1);
    const result = peer.preferences.snapshot(); result.records.splice(0);
    expect(peer.preferences.snapshot().records).toHaveLength(1);
    const record = peer.preferences.get("theme.mode")!;
    expect(() => peer.preferences.merge(snapshot({ ...record, revision: { ...record.revision, counter: Number.MAX_SAFE_INTEGER + 1 } }))).toThrow();
    peer.preferences.merge(snapshot({ ...record, revision: { ...record.revision, counter: Number.MAX_SAFE_INTEGER, opId: crypto.randomUUID() } }));
    expect(() => peer.preferences.put({ key: "theme.mode", value: "light" })).toThrow("cannot advance safely");
    expect(peer.host.readPreferencesState()?.counter).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("bounded preference schema and reusable visual registry", () => {
  test("accepts practical colors, font families, dimensions, opacity and content-addressed backgrounds", () => {
    const tokens = { "--app-surface": "rgb(24 24 24 / 85%)", "--text": "oklch(.9 .02 250)", "--ui-font": '"SF Pro Text", system-ui', "--code-font-size": "14px", "--font-weight": "450", "--radius": "0", "--spacing-md": "1rem", "--sidebar-blur": "20px", "--surface-opacity": ".85" };
    expect(parseThemeTokens(tokens)).toEqual(tokens);
    expect(Object.keys(THEME_TOKEN_DEFINITIONS).length).toBeGreaterThan(60);
    expect(parsePreferenceChange({ key: "theme.background", value: { kind: "asset", sha256: "a".repeat(64), fit: "cover", opacity: .5, blur: 10 } })).toMatchObject({ value: { kind: "asset", sha256: "a".repeat(64) } });
    expect(parsePreferenceChange({ key: "theme.background", value: { kind: "gradient", angle: 45, stops: [{ color: "#123456", position: 0 }, { color: "#abcdef", position: 1 }] } })).toMatchObject({ value: { kind: "gradient" } });
  });

  test("rejects host configuration, credentials, filesystem/URL payloads, window layout and malformed schema", () => {
    const id = crypto.randomUUID();
    const invalid: unknown[] = [
      { key: "omp.settings", value: {} }, { key: "credentials", value: "not-a-secret-fixture" }, { key: "window.layout", value: {} },
      { key: "theme.tokens", value: { "--api-key": "not-a-secret-fixture" } },
      { key: "theme.tokens", value: { "--sidebar-width": "300px" } },
      { key: "theme.tokens", value: { "--app-surface": "url(file:///etc/passwd)" } },
      { key: "theme.tokens", value: { "--ui-font": "url(https://example.invalid/font)" } },
      { key: "theme.tokens", value: { "--font-size": "400px" } },
      { key: "theme.tokens", value: { "--surface-opacity": "2" } },
      { key: "theme.tokens", value: { "--app-surface": "rgb()" } },
      { key: "theme.tokens", value: { "--app-surface": "rgb(1)" } },
      { key: "theme.tokens", value: { "--app-surface": "rgb(1deg, 2, 3)" } },
      { key: "theme.tokens", value: { "--app-surface": "hsl(120 50 30)" } },
      { key: "theme.tokens", value: { "--app-surface": "lab(50, 2, 3)" } },
      { key: "theme.tokens", value: { "--app-surface": "rgb(20%, 10, 40)" } },
      { key: "theme.tokens", value: { "--ui-font": '"Unclosed font' } },
      { key: "theme.background", value: { kind: "asset", path: "/tmp/file", fit: "cover", opacity: 1, blur: 0 } },
      { key: "theme.background", value: { kind: "color", color: "#fff", file: "/tmp/file" } },
      { key: "theme.background", value: { kind: "gradient", angle: 45, stops: [{ color: "#fff", position: 1 }, { color: "#000", position: 0 }] } },
      { key: `sidebar.project.${id}`, value: { hostId: id, sectionId: null, position: 0, path: "/tmp/project" } },
      { key: `sidebar.section.${id}`, value: { name: "x".repeat(121), position: 0 } },
      { key: "sidebar.session./tmp/session", value: {} },
      { key: "theme.mode", value: "dark", deleted: true },
      { key: "general.reduceMotion", value: "true" },
    ];
    for (const input of invalid) expect(() => parsePreferenceChange(input)).toThrow();
    expect(() => parsePreferencesSnapshot({ version: 1, records: Array(PREFERENCE_LIMITS.records + 1).fill({}) })).toThrow("too many records");
    const peer = replica();
    for (const input of invalid) expect(() => peer.preferences.put(input as PreferenceChange)).toThrow();
    expect(peer.preferences.snapshot()).toEqual({ version: 1, records: [] });
  });
});
