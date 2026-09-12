import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, copyFile, lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_THEME, parseThemeDocument, type ThemeDocument, type ThemeState } from "../../../packages/shared/src/theme";
import type { PreferenceChange } from "../../../packages/shared/src/preferences";
import type { PreferencesSync } from "./preferences-sync";
import type { HostStore } from "./store";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const THEME_FIELDS = ["mode", "material", "opaqueWindows", "tokens", "background", "appearance"] as const;
const serialize = (document: ThemeDocument) => JSON.stringify(document, null, 2) + "\n";
export class ThemeConflictError extends Error { constructor() { super("The theme changed elsewhere. Reload it before saving; your edits have been retained."); } }

/** The JSON file is an editable projection of replicated app preferences. The
 * two-hash marker distinguishes an interrupted managed write from an external edit. */
export class ThemeFile {
  readonly filePath: string;
  fileError?: string;
  #observedHash?: string;
  #tail: Promise<unknown> = Promise.resolve();
  #watcher?: FSWatcher;
  #poll?: ReturnType<typeof setInterval>;
  #timer?: ReturnType<typeof setTimeout>;
  #disposed = false;
  constructor(private options: { dataDirectory: string; store: HostStore; preferences: PreferencesSync; changed(): void }) {
    this.filePath = join(options.dataDirectory, "theme.json");
  }
  #document(): ThemeDocument {
    const fields: Record<string, unknown> = structuredClone(DEFAULT_THEME) as unknown as Record<string, unknown>;
    let hasLegacyThemePreference = false, hasOpaqueWindows = false;
    for (const field of THEME_FIELDS) {
      const record = this.options.preferences.store.get(`theme.${field}`);
      if (field === "opaqueWindows" && record) hasOpaqueWindows = true;
      if (record && !record.deleted) {
        fields[field] = record.value;
        if (field !== "opaqueWindows") hasLegacyThemePreference = true;
      }
    }
    // Existing preference stores predate this explicit switch. Preserve their
    // native treatment while a genuinely new profile starts at the v2 default.
    if (hasLegacyThemePreference && !hasOpaqueWindows) fields.opaqueWindows = fields.material === "none";
    return parseThemeDocument(fields);
  }
  #state(): ThemeState {
    const records = this.options.preferences.snapshot().records.filter(record => record.key.startsWith("theme."));
    return { document: this.#document(), revision: digest(JSON.stringify({ records, file: this.#observedHash, error: this.fileError })),
      filePath: this.filePath, ...(this.fileError ? { fileError: this.fileError } : {}) };
  }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error("Theme service is stopping."));
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => {});
    return next;
  }
  async #target(): Promise<string> {
    try { return await realpath(this.filePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await lstat(this.filePath).catch(() => undefined))?.isSymbolicLink()) throw new Error("The theme symlink points to a missing file.");
      return this.filePath;
    }
  }
  #adopt(document: ThemeDocument): void {
    const current = this.#document();
    const changes = THEME_FIELDS.filter(field => JSON.stringify(document[field]) !== JSON.stringify(current[field])
      || field === "opaqueWindows" && !this.options.preferences.store.get("theme.opaqueWindows"))
      .map(field => (document[field] === undefined ? { key: `theme.${field}`, deleted: true } : { key: `theme.${field}`, value: document[field] }) as PreferenceChange);
    if (changes.length) this.options.preferences.putMany(changes);
  }
  async #writeManaged(document: ThemeDocument): Promise<void> {
    const target = await this.#target();
    const contents = serialize(document);
    const nextHash = digest(contents);
    const marker = this.options.store.readThemeFileMarker();
    this.options.store.writeThemeFileMarker({ currentHash: this.#observedHash ?? marker?.currentHash, pendingHash: nextHash });
    const temporary = join(dirname(target), `.agent-desktop-theme-${randomUUID()}.tmp`);
    const metadata = await stat(target).catch(() => undefined);
    const file = await open(temporary, "wx", metadata ? metadata.mode & 0o777 : 0o600);
    try {
      if (metadata) {
        const created = await file.stat();
        if (created.uid !== metadata.uid || created.gid !== metadata.gid) await file.chown(metadata.uid, metadata.gid);
        await file.chmod(metadata.mode & 0o777);
      }
      await file.writeFile(contents); await file.sync(); await file.close();
      await rename(temporary, target);
      const directory = await open(dirname(target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      this.#observedHash = nextHash;
      this.options.store.writeThemeFileMarker({ currentHash: nextHash });
    } finally { await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
  async #reconcile(): Promise<void> {
    const previous = `${this.#observedHash}:${this.fileError}`;
    try {
      const target = await this.#target();
      const metadata = await stat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (!metadata) {
        this.#observedHash = undefined; this.fileError = undefined;
        const document = this.#document();
        this.#adopt(document);
        await this.#writeManaged(this.#document());
      } else {
        if (!metadata.isFile() || metadata.size > 256 * 1024) throw new Error("The theme file must be a regular JSON file smaller than 256 KiB.");
        const contents = await readFile(target);
        const actualHash = digest(contents);
        this.#observedHash = actualHash;
        const marker = this.options.store.readThemeFileMarker();
        const managed = actualHash === marker?.currentHash || actualHash === marker?.pendingHash;
        let legacy = false;
        if (managed) {
          try {
            const raw = JSON.parse(contents.toString("utf8"));
            if (raw?.version === 1) { parseThemeDocument(raw); legacy = true; }
          } catch { this.fileError = "theme.json is invalid. The last valid theme remains active; correct the file or save a valid theme from Settings."; return; }
        }
        if (!managed) {
          let document: ThemeDocument;
          try { document = parseThemeDocument(JSON.parse(contents.toString("utf8"))); }
          catch { this.fileError = "theme.json is invalid. The last valid theme remains active; correct the file or save a valid theme from Settings."; return; }
          this.#adopt(document);
          this.options.store.writeThemeFileMarker({ currentHash: actualHash });
        } else if (!legacy && actualHash !== digest(serialize(this.#document()))) {
          this.#adopt(this.#document());
          await this.#writeManaged(this.#document());
        }
        else if (!legacy && marker?.pendingHash) this.options.store.writeThemeFileMarker({ currentHash: actualHash });
        this.fileError = undefined;
      }
    } catch {
      this.fileError = "The theme file could not be read or written. The last valid theme remains active. Check its file permissions, link target and size.";
    } finally {
      if (previous !== `${this.#observedHash}:${this.fileError}`) this.options.changed();
    }
  }
  async start(): Promise<void> {
    await this.refresh();
    this.#watcher = watch(dirname(this.filePath), (_event, name) => { if (!name || String(name) === "theme.json") this.schedule(); });
    this.#watcher.on("error", () => { this.fileError = "Theme file watching failed; periodic checks remain active."; this.options.changed(); });
    // Covers editors replacing a symlink target outside this directory and missed OS events.
    this.#poll = setInterval(() => this.schedule(), 2000); this.#poll.unref();
  }
  schedule(): void {
    if (this.#disposed) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.refresh().catch(() => { if (!this.#disposed) { this.fileError = "Theme synchronization failed. The last valid theme remains active."; this.options.changed(); } });
    }, 40);
    this.#timer.unref();
  }
  refresh(): Promise<ThemeState> { return this.#queue(async () => { await this.#reconcile(); return this.#state(); }); }
  set(document: unknown, expectedRevision: string): Promise<ThemeState> {
    const parsed = parseThemeDocument(document);
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error("The current theme revision is required.");
    return this.#queue(async () => {
      await this.#reconcile();
      if (this.#state().revision !== expectedRevision) throw new ThemeConflictError();
      if (this.fileError) {
        const target = await this.#target();
        const metadata = await stat(target);
        if (!metadata.isFile() || metadata.size > 256 * 1024) throw new Error("Repair the theme file before replacing it from Settings.");
        const backup = join(dirname(this.filePath), `theme.invalid-${Date.now()}.json`);
        await copyFile(target, backup); await chmod(backup, 0o600);
      }
      // Persist the file before acknowledging the UI; a crash before preference
      // commit is an unacknowledged edit and recovery restores the prior values.
      await this.#writeManaged(parsed);
      this.#adopt(parsed);
      this.fileError = undefined; this.options.changed();
      return this.#state();
    });
  }
  async dispose(): Promise<void> {
    this.#disposed = true; this.#watcher?.close(); clearInterval(this.#poll); clearTimeout(this.#timer); await this.#tail;
  }
}
