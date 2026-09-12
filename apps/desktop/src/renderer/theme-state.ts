import { DEFAULT_THEME, parseThemeDocument, type ThemeDocument, type ThemeState } from "../../../../packages/shared/src/theme";
import type { DraftCache } from "./drafts";
import { themePresentation } from "./theme-application";

export interface ThemeStorage { getTheme(): Promise<ThemeState>; setTheme(document: ThemeDocument, expectedRevision: string): Promise<ThemeState> }
/** The saved theme and this window's editable preview have separate identities. */
export class ThemeEditor {
  current?: ThemeState;
  draft = structuredClone(DEFAULT_THEME);
  preview = structuredClone(DEFAULT_THEME);
  baseRevision?: string;
  conflict?: ThemeState;
  dirty = false;
  /** Advanced preview edits require an explicit save, including during an automatic write. */
  manualDirty = false;
  loading = false;
  saving = false;
  error?: string;
  validationError?: string;
  cacheWarning?: string;
  /** Unsaved JSON text belongs to this window, including text that does not parse. */
  advanced?: { text: string; dirty: boolean; error?: string };
  private epoch = 0;
  private pending?: Promise<void>;
  private savingPromise?: Promise<void>;
  private committing?: Promise<boolean>;
  private again = false;
  private listeners = new Set<() => void>();
  constructor(private storage: ThemeStorage, private cache?: DraftCache) {
    try { const saved = JSON.parse(cache?.read("agent-desktop:last-theme:v1") ?? "null"); if (saved && typeof saved.revision === "string" && typeof saved.filePath === "string") this.ingest({ ...saved, document: parseThemeDocument(saved.document) }); }
    catch { this.cacheWarning = "The last theme cache could not be read. The saved theme file will be loaded."; }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private cacheCurrent() { try { if (this.current) this.cache?.write("agent-desktop:last-theme:v1", JSON.stringify(this.current)); this.cacheWarning = undefined; } catch { this.cacheWarning = "The current theme could not be cached on this device."; } }
  ingest(state: ThemeState) {
    const valid = { ...state, document: themePresentation(state.document).document };
    this.current = valid;
    if (this.dirty && this.baseRevision !== state.revision) this.conflict = valid;
    else if (!this.dirty) { this.manualDirty = false; this.draft = structuredClone(valid.document); this.preview = structuredClone(valid.document); this.baseRevision = valid.revision; this.conflict = undefined; this.validationError = undefined; }
    this.cacheCurrent(); this.changed();
  }
  edit(document: ThemeDocument, manual = true) {
    this.error = undefined;
    try { this.draft = themePresentation(document).document; this.preview = this.draft; this.validationError = undefined; }
    catch (cause) { this.draft = document; this.validationError = message(cause); }
    this.dirty = JSON.stringify(this.draft) !== JSON.stringify(this.current?.document ?? DEFAULT_THEME);
    this.manualDirty = this.dirty && (manual || this.manualDirty);
    if (!this.dirty && this.current) { this.baseRevision = this.current.revision; this.conflict = undefined; }
    this.changed();
  }
  resolve(choice: "local" | "remote") {
    if (!this.current) return;
    this.baseRevision = this.current.revision; this.conflict = undefined;
    if (choice === "remote") { this.dirty = false; this.ingest(this.current); }
    else this.edit(this.draft, this.manualDirty);
    this.changed();
  }
  reset() { this.edit(structuredClone(DEFAULT_THEME)); }
  refresh(): Promise<void> {
    if (this.pending) { this.again = true; return this.pending; }
    const epoch = this.epoch;
    this.loading = true; this.changed();
    this.pending = this.storage.getTheme().then(state => { if (epoch === this.epoch) { this.ingest(state); this.error = undefined; } }).catch(cause => { if (epoch === this.epoch) this.error = message(cause); }).finally(() => {
      this.pending = undefined; this.loading = false; this.changed();
      if (this.again) { this.again = false; void this.refresh(); }
    });
    return this.pending;
  }
  /** Normal Appearance controls save immediately; consecutive edits keep their latest snapshot. */
  commit(document: ThemeDocument): Promise<boolean> {
    if (this.manualDirty) return Promise.resolve(false);
    this.edit(document, false);
    if (this.committing) return this.committing;
    this.committing = (async () => {
      do {
        await this.save();
        if (this.error || this.conflict || this.validationError || this.manualDirty || !this.baseRevision) return false;
      } while (this.dirty);
      return true;
    })().finally(() => { this.committing = undefined; });
    return this.committing;
  }
  save(): Promise<void> {
    if (this.savingPromise) return this.savingPromise;
    this.savingPromise = this.saveCurrent().finally(() => { this.savingPromise = undefined; });
    return this.savingPromise;
  }
  private async saveCurrent() {
    if (this.saving || !this.baseRevision || this.conflict || this.validationError || !this.dirty) return;
    const snapshot = parseThemeDocument(this.draft); const revision = this.baseRevision;
    this.saving = true; this.error = undefined; this.epoch++; this.changed();
    try {
      const result = await this.storage.setTheme(snapshot, revision);
      this.epoch++;
      const newer = JSON.stringify(this.draft) !== JSON.stringify(snapshot);
      this.current = { ...result, document: parseThemeDocument(result.document) }; this.baseRevision = result.revision; this.conflict = undefined;
      if (!newer) { this.draft = structuredClone(result.document); this.preview = structuredClone(result.document); this.dirty = false; this.manualDirty = false; this.validationError = undefined; }
      else this.dirty = JSON.stringify(this.draft) !== JSON.stringify(result.document);
      this.cacheCurrent();
    } catch (cause) { this.error = message(cause); await this.refresh(); this.error = message(cause); }
    finally { this.saving = false; this.changed(); }
  }
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
