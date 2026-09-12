import { createHash } from "node:crypto";
import type { BrowserAutocompleteMatch, BrowserHistoryEntry } from "@agent-desktop/shared";

const MAX_RECORDS = 1_000;
const MAX_BYTES = 4 * 1024 * 1024;
const safe = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && (empty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const allowed = (url: string) => { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; } };

interface SavedRecord { id: string; url: string; title: string; lastVisitedAt: number; visitCount: number; sourceKeys: string[] }
interface SavedTombstone { url: string; deletedAt: number; sourceKeys: string[] }
interface SavedState { version: 1; revision: number; records: SavedRecord[]; tombstones: SavedTombstone[] }
export interface ObservedBrowserHistory { sourceKey: string; entry: BrowserHistoryEntry }

function parseState(value: unknown): SavedState {
  if (value === undefined) return { version: 1, revision: 0, records: [], tombstones: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved browser autocomplete history.");
  const input = value as Partial<SavedState>;
  if (input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision! < 0 || !Array.isArray(input.records) || !Array.isArray(input.tombstones)
    || input.records.length > MAX_RECORDS || input.tombstones.length > MAX_RECORDS) throw new Error("Invalid saved browser autocomplete history.");
  const records = Array.from({ length: input.records.length }, (_, index): SavedRecord => {
    const row = input.records![index];
    if (!row || typeof row !== "object" || !safe(row.id, 100) || !safe(row.url, 8192) || !allowed(row.url) || !safe(row.title, 1024, true)
      || !Number.isSafeInteger(row.lastVisitedAt) || row.lastVisitedAt < 0 || !Number.isSafeInteger(row.visitCount) || row.visitCount < 1
      || !Array.isArray(row.sourceKeys) || row.sourceKeys.length > 32 || row.sourceKeys.some(item => !safe(item, 128))) throw new Error("Invalid saved browser autocomplete record.");
    return { id: row.id, url: row.url, title: row.title, lastVisitedAt: row.lastVisitedAt, visitCount: row.visitCount, sourceKeys: [...row.sourceKeys] };
  });
  const tombstones = Array.from({ length: input.tombstones.length }, (_, index): SavedTombstone => {
    const row = input.tombstones![index];
    if (!row || typeof row !== "object" || !safe(row.url, 8192) || !allowed(row.url) || !Number.isSafeInteger(row.deletedAt) || row.deletedAt < 0
      || !Array.isArray(row.sourceKeys) || row.sourceKeys.length > 32 || row.sourceKeys.some(item => !safe(item, 128))) throw new Error("Invalid saved browser autocomplete deletion.");
    return { url: row.url, deletedAt: row.deletedAt, sourceKeys: [...row.sourceKeys] };
  });
  if (new Set(records.map(row => row.id)).size !== records.length || new Set(records.map(row => row.url)).size !== records.length
    || new Set(tombstones.map(row => row.url)).size !== tombstones.length || records.some(row => tombstones.some(item => item.url === row.url))) throw new Error("Ambiguous saved browser autocomplete history.");
  return { version: 1, revision: input.revision as number, records, tombstones };
}

/** Host-owned history contains only successful navigation entries read back from
 * an exact OMP target. It never imports personal Chrome/Electron browsing data. */
export class BrowserAutocompleteRecords {
  constructor(private readonly read: () => unknown, private readonly write: (value: SavedState) => void, private readonly now = Date.now) {}

  observe(entries: readonly ObservedBrowserHistory[], explicitCurrent = false): string {
    const state = parseState(this.read()); let changed = false;
    for (let index = 0; index < entries.length; index++) {
      const { sourceKey, entry } = entries[index]!;
      if (!safe(sourceKey, 128) || !safe(entry.url, 8192) || !allowed(entry.url) || !safe(entry.title, 1024, true)) continue;
      const deleted = state.tombstones.find(row => row.url === entry.url);
      // Native entry IDs and target IDs can rotate after a worker restart. A
      // new source key alone is not a revisit; only a confirmed navigation's
      // explicit current entry may restore a deleted URL.
      if (deleted && !(explicitCurrent && entry.current)) continue;
      if (deleted) { state.tombstones.splice(state.tombstones.indexOf(deleted), 1); changed = true; }
      const saved = state.records.find(row => row.url === entry.url);
      const visitedAt = entry.current ? this.now() : this.now() - Math.max(1, entries.length - index);
      if (!saved) { state.records.push({ id: crypto.randomUUID(), url: entry.url, title: entry.title, lastVisitedAt: visitedAt, visitCount: 1, sourceKeys: [sourceKey] }); changed = true; }
      else {
        const nextTitle = entry.title || saved.title;
        const newSource = !saved.sourceKeys.includes(sourceKey);
        if (nextTitle !== saved.title || newSource || explicitCurrent && entry.current) {
          saved.title = nextTitle;
          if (newSource) saved.sourceKeys = [...saved.sourceKeys.slice(-31), sourceKey];
          if (entry.current && (newSource || explicitCurrent)) { saved.lastVisitedAt = visitedAt; saved.visitCount++; }
          changed = true;
        }
      }
    }
    if (changed) this.save(state);
    return this.revision(state);
  }

  matches(query: string, tokens: (kind: "accept" | "delete", id: string) => string): BrowserAutocompleteMatch[] {
    const state = parseState(this.read()), needle = query.trim().toLocaleLowerCase();
    const rows = state.records.filter(row => !needle || `${row.title}\n${row.url}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt || b.visitCount - a.visitCount || a.url.localeCompare(b.url)).slice(0, needle ? 7 : 8)
      .map((row): BrowserAutocompleteMatch => ({ id: `history:${row.id}`, type: "history", destinationURL: row.url, fillIntoEdit: row.url,
        title: row.title || row.url, ...(row.title ? { description: row.url } : {}), inlineAutocompletion: "", isSearch: false,
        deletable: true, canBeDefault: false, acceptToken: tokens("accept", row.id), deleteToken: tokens("delete", row.id) }));
    if (needle) rows.push({ id: `search:${hash(query).slice(0, 24)}`, type: "search-what-you-typed", destinationURL: `https://www.google.com/search?${new URLSearchParams({ q: query.trim() })}`,
      fillIntoEdit: query, title: query, inlineAutocompletion: "", isSearch: true, deletable: false, canBeDefault: true, acceptToken: tokens("accept", `search:${hash(query)}`) });
    return rows.slice(0, 8);
  }

  delete(id: string): string {
    const state = parseState(this.read()), record = state.records.find(row => row.id === id);
    if (!record) throw new Error("The browser suggestion changed. Refresh the address bar.");
    state.records.splice(state.records.indexOf(record), 1);
    const prior = state.tombstones.find(row => row.url === record.url); if (prior) state.tombstones.splice(state.tombstones.indexOf(prior), 1);
    state.tombstones.push({ url: record.url, deletedAt: this.now(), sourceKeys: [...record.sourceKeys] });
    this.save(state); return this.revision(state);
  }

  revision(value = parseState(this.read())): string { return hash(JSON.stringify({ revision: value.revision, records: value.records, tombstones: value.tombstones })); }
  private save(state: SavedState) {
    state.records.sort((a, b) => b.lastVisitedAt - a.lastVisitedAt); state.records.splice(MAX_RECORDS);
    state.tombstones.sort((a, b) => b.deletedAt - a.deletedAt); state.tombstones.splice(MAX_RECORDS);
    state.revision++;
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) throw new Error("Browser autocomplete history exceeded its storage bound.");
    this.write(state);
  }
}

export const browserAutocompleteSourceKey = (owner: { kind: "session" | "draft"; id: string }, target: { name: string; targetId: string }, nativeId: string) =>
  hash(JSON.stringify([owner.kind, owner.id, target.name, target.targetId, nativeId]));
