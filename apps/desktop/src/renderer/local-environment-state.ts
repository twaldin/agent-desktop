import { parseLocalEnvironment, serializeLocalEnvironment, type CommandEnvelope, type DesktopBridge, type LocalEnvironmentCatalogItem, type LocalEnvironmentConfig, type LocalEnvironmentSaveResult } from "@agent-desktop/shared";
import type { OfflineCache } from "./offline-cache";

type Bridge = Pick<DesktopBridge, "workspaceQuery" | "command" | "subscribe">;
type SaveEnvelope = CommandEnvelope & { command: { type: "workspace.mutate"; target: { projectId: string }; action: { type: "environment.save"; configPath?: string | null; expectedRevision: string | null; raw: string } } };
export interface EnvironmentEdit { configPath: string | null; expectedRevision: string | null; raw: string; version: number; dirty: boolean; conflict?: LocalEnvironmentCatalogItem | null }
interface Pending { envelope: SaveEnvelope; key: string; version: number }
interface CachedState { version: 1; items: LocalEnvironmentCatalogItem[]; edits: Array<[string, EnvironmentEdit]>; selected?: string; pending?: Pending }

const revisionPattern = /^[a-f0-9]{64}$/;
const uncertainCommandCodes = new Set(["OUTCOME_UNKNOWN", "HOST_STOPPING", "COMMAND_ID_REUSED"]);
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const blank = (): LocalEnvironmentConfig => ({ version: 1, name: "", setup: { script: "" } });
const configBytes = (raw: string) => new TextEncoder().encode(raw).length;
const validRevision = (value: unknown): value is string => typeof value === "string" && revisionPattern.test(value);

function catalogItem(value: unknown): LocalEnvironmentCatalogItem {
  if (!value || typeof value !== "object") throw new Error("Invalid cached environment catalog item.");
  const item = value as Partial<LocalEnvironmentCatalogItem>;
  if (typeof item.configPath !== "string" || !item.configPath) throw new Error("Invalid cached environment path.");
  if (item.type === "error") {
    if (typeof item.error !== "string" || !(item.revision === undefined || validRevision(item.revision))) throw new Error("Invalid cached environment error.");
    return { type: "error", configPath: item.configPath, error: item.error, ...(item.revision ? { revision: item.revision } : {}) };
  }
  if (item.type !== "environment" || !validRevision(item.revision) || !item.environment) throw new Error("Invalid cached environment entry.");
  const environment = parseLocalEnvironment(serializeLocalEnvironment(item.environment));
  return { type: "environment", configPath: item.configPath, revision: item.revision, environment };
}

function editEntry(value: unknown): [string, EnvironmentEdit] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !value[1] || typeof value[1] !== "object") throw new Error("Invalid saved environment edit.");
  const [key, rawEdit] = value, edit = rawEdit as Partial<EnvironmentEdit>;
  if (typeof edit.raw !== "string" || configBytes(edit.raw) > 1024 * 1024 || !(edit.configPath === null || typeof edit.configPath === "string") ||
    !(edit.expectedRevision === null || validRevision(edit.expectedRevision)) || !Number.isSafeInteger(edit.version) || (edit.version as number) < 0 || typeof edit.dirty !== "boolean")
    throw new Error("Invalid saved environment edit.");
  if (key === "new" ? edit.configPath !== null : edit.configPath !== key) throw new Error("Saved environment edit has the wrong path.");
  let conflict: LocalEnvironmentCatalogItem | null | undefined;
  if (edit.conflict === null) conflict = null;
  else if (edit.conflict !== undefined) conflict = catalogItem(edit.conflict);
  return [key, { configPath: edit.configPath, expectedRevision: edit.expectedRevision, raw: edit.raw, version: edit.version as number, dirty: edit.dirty, ...(conflict !== undefined ? { conflict } : {}) }];
}

function pendingReceipt(value: unknown, edits: Map<string, EnvironmentEdit>, projectId: string): Pending | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Invalid saved environment receipt.");
  const pending = value as Partial<Pending>, command = pending.envelope?.command, action = command?.type === "workspace.mutate" ? command.action : undefined;
  const editor = typeof pending.key === "string" ? edits.get(pending.key) : undefined;
  if (typeof pending.envelope?.id !== "string" || !pending.envelope.id || command?.type !== "workspace.mutate" || command.target?.projectId !== projectId ||
    action?.type !== "environment.save" || !editor || !Number.isSafeInteger(pending.version) || (pending.version as number) < 0 || (pending.version as number) > editor.version ||
    !(action.configPath === undefined || action.configPath === null || typeof action.configPath === "string") || !(action.expectedRevision === null || validRevision(action.expectedRevision)) ||
    typeof action.raw !== "string" || configBytes(action.raw) > 1024 * 1024)
    throw new Error("Invalid saved environment receipt.");
  parseLocalEnvironment(action.raw);
  if (pending.version === editor.version && (action.raw !== editor.raw || (action.configPath ?? null) !== editor.configPath || action.expectedRevision !== editor.expectedRevision))
    throw new Error("Saved environment receipt does not match its edit.");
  if ((action.configPath ?? null) !== editor.configPath || action.expectedRevision !== editor.expectedRevision)
    throw new Error("Saved environment receipt has stale file identity.");
  return pending as Pending;
}

/** One owner/project editor. Pending saves reuse their exact durable command identity. */
export class LocalEnvironmentState {
  items: LocalEnvironmentCatalogItem[] = [];
  edits = new Map<string, EnvironmentEdit>();
  selected?: string;
  pending?: Pending;
  connected = false;
  restored = false;
  loading = false;
  busy = false;
  error?: string;
  cacheWarning?: string;
  notice?: string;
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  private restoring?: Promise<void>;
  private off?: () => void;
  private epoch = 0;
  private selectionEpoch = 0;
  readonly cacheKey: string;

  constructor(private bridge: Bridge, readonly hostId: string, readonly projectId: string, private cache: OfflineCache, private localHostId?: string) {
    if (!hostId || !projectId) throw new Error("Environment editor requires a host and project.");
    this.cacheKey = `agent-desktop:local-environments:v1:${encodeURIComponent(hostId)}:${encodeURIComponent(projectId)}`;
  }

  get editor() { return this.selected ? this.edits.get(this.selected) : undefined; }
  get config() { try { return this.editor ? parseLocalEnvironment(this.editor.raw) : undefined; } catch { return undefined; } }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }

  start() {
    this.off ??= this.bridge.subscribe(event => {
      if ((event.hostId ?? this.localHostId) === this.hostId && event.type === "workspace" && "projectId" in event.target && event.target.projectId === this.projectId) void this.refresh();
    });
  }
  stop() { this.off?.(); this.off = undefined; this.epoch++; }
  setConnected(value: boolean) {
    this.connected = value;
    if (!value) { this.epoch++; this.loading = false; }
    this.changed();
    if (value) void this.refresh();
  }

  restore(): Promise<void> {
    return this.restoring ??= (async () => {
      try {
        const raw = await this.cache.read(this.cacheKey), saved = JSON.parse(raw ?? "null") as Partial<CachedState> | null;
        if (saved !== null) {
          if (saved.version !== 1 || !Array.isArray(saved.items) || !Array.isArray(saved.edits)) throw new Error("Unknown environment editor cache format.");
          const edits = new Map<string, EnvironmentEdit>();
          for (const value of saved.edits) {
            const [key, edit] = editEntry(value);
            if (edits.has(key)) throw new Error("Duplicate saved environment edit.");
            edits.set(key, edit);
          }
          const pending = pendingReceipt(saved.pending, edits, this.projectId);
          this.items = saved.items.map(catalogItem);
          this.edits = edits;
          this.selected = typeof saved.selected === "string" && edits.has(saved.selected) ? saved.selected : undefined;
          this.pending = pending;
        }
        this.restored = true;
        this.cacheWarning = undefined;
      } catch (cause) {
        this.items = [];
        this.edits = new Map();
        this.selected = undefined;
        this.pending = undefined;
        this.restored = true;
        this.cacheWarning = `Environment editor recovery needs attention. ${message(cause)}`;
      }
      this.changed();
    })();
  }

  private persist() {
    if (!this.restored) return Promise.reject(new Error(this.cacheWarning ?? "Environment editor is still restoring."));
    const serialized = JSON.stringify({ version: 1, items: this.items, edits: [...this.edits], selected: this.selected, pending: this.pending });
    const task = this.writes.catch(() => {}).then(() => this.cache.write(this.cacheKey, serialized));
    this.writes = task;
    return task.then(() => { this.cacheWarning = undefined; this.changed(); }, cause => {
      this.cacheWarning = `Environment edit could not be saved on this device. ${message(cause)}`;
      this.changed();
      throw cause;
    });
  }
  private saveSoon() { void this.persist().catch(() => {}); this.changed(); }

  async refresh() {
    await this.restore();
    if (!this.restored || !this.connected) return;
    const epoch = ++this.epoch;
    this.loading = true;
    this.changed();
    try {
      const result = await this.bridge.workspaceQuery({ projectId: this.projectId }, { type: "environments.list" }, this.hostId);
      if (epoch !== this.epoch || !this.connected) return;
      if (result.type !== "environments.list") throw new Error("The host did not return an environment catalog.");
      this.items = result.environments;
      this.error = undefined;
      await this.persist();
    } catch (cause) {
      if (epoch === this.epoch) this.error = message(cause);
    } finally {
      if (epoch === this.epoch) { this.loading = false; this.changed(); }
    }
  }

  create(name = "") {
    if (!this.restored || this.busy) return;
    this.selectionEpoch++;
    this.edits.has("new") || this.edits.set("new", { configPath: null, expectedRevision: null, raw: serializeLocalEnvironment({ ...blank(), name }), version: 0, dirty: true });
    this.selected = "new";
    this.notice = undefined;
    this.saveSoon();
  }

  async open(configPath: string) {
    if (!this.restored) return;
    const selection = ++this.selectionEpoch;
    if (this.edits.has(configPath)) { this.selected = configPath; this.saveSoon(); return; }
    const item = this.items.find(candidate => candidate.configPath === configPath);
    if (!item) return;
    if (item.type === "environment") {
      this.edits.set(configPath, { configPath, expectedRevision: item.revision, raw: serializeLocalEnvironment(item.environment), version: 0, dirty: false });
      this.selected = configPath;
      this.saveSoon();
      return;
    }
    try {
      const value = await this.bridge.workspaceQuery({ projectId: this.projectId }, { type: "environment.read", configPath }, this.hostId);
      if (selection !== this.selectionEpoch) return;
      if (value.type !== "environment.read" || value.configPath !== configPath) throw new Error("The configuration cannot be opened as a text file.");
      if (!validRevision(value.revision) || configBytes(value.raw) > 1024 * 1024) throw new Error("The configuration is too large or has an invalid revision.");
      this.edits.set(configPath, { configPath, expectedRevision: value.revision, raw: value.raw, version: 0, dirty: false });
      this.selected = configPath;
      this.error = undefined;
      this.saveSoon();
    } catch (cause) {
      if (selection !== this.selectionEpoch) return;
      this.error = message(cause);
      this.changed();
    }
  }

  back() { this.selectionEpoch++; this.selected = undefined; this.saveSoon(); }
  edit(config: LocalEnvironmentConfig) { this.editRaw(serializeLocalEnvironment(config)); }
  editRaw(raw: string) {
    const editor = this.editor;
    if (!editor || !this.restored) return;
    editor.raw = raw;
    editor.version++;
    editor.dirty = true;
    this.notice = undefined;
    this.saveSoon();
  }
  async acceptCurrent() {
    const editor = this.editor, current = editor?.conflict;
    if (!editor || current?.type !== "environment") return;
    editor.raw = serializeLocalEnvironment(current.environment);
    editor.expectedRevision = current.revision;
    editor.dirty = false;
    editor.version++;
    delete editor.conflict;
    this.saveSoon();
  }
  keepEdit() {
    const editor = this.editor;
    if (!editor || editor.conflict === undefined) return;
    const current = editor.conflict;
    if (current !== null && !current.revision) return;
    editor.expectedRevision = current?.revision ?? null;
    delete editor.conflict;
    editor.version++;
    editor.dirty = true;
    this.saveSoon();
  }

  async save() {
    await this.restore();
    const editor = this.editor;
    if (!this.restored || !editor || !this.selected || this.busy || this.pending || !this.connected || editor.conflict !== undefined) return;
    try {
      const config = parseLocalEnvironment(editor.raw);
      if (!config.name.trim()) throw new Error("Name the environment before saving.");
    } catch (cause) { this.error = message(cause); this.changed(); return; }
    this.pending = { key: this.selected, version: editor.version, envelope: { id: crypto.randomUUID(), command: { type: "workspace.mutate", target: { projectId: this.projectId }, action: { type: "environment.save", configPath: editor.configPath, expectedRevision: editor.expectedRevision, raw: editor.raw } } } };
    await this.deliver();
  }
  async retry() { await this.restore(); if (this.pending && this.connected && !this.busy) await this.deliver(); }

  private async deliver() {
    const pending = this.pending;
    if (!pending) return;
    this.busy = true;
    this.error = undefined;
    this.notice = undefined;
    this.changed();
    try {
      await this.persist();
      const response = await this.bridge.command(pending.envelope, this.hostId);
      if (response.commandId !== pending.envelope.id) throw new Error("The host returned a different command receipt.");
      let refreshCatalog = false;
      if (!response.ok) {
        // These responses do not prove whether this exact command reached the
        // host ledger or applied. Retain its durable identity for inspection.
        if (uncertainCommandCodes.has(response.error.code)) throw new Error(response.error.message);
        this.pending = undefined;
        this.error = response.error.message;
      } else {
        const value = response.value;
        if (!value || !("type" in value) || value.type !== "environment.save") throw new Error("The host did not return the environment save receipt.");
        if (value.result.type === "conflict" && (value.result.expectedRevision !== pending.envelope.command.action.expectedRevision || value.result.attempted.raw !== pending.envelope.command.action.raw))
          throw new Error("The host returned a mismatched environment conflict.");
        const rollback = this.apply(pending, value.result);
        this.pending = undefined;
        refreshCatalog = true;
        try { await this.persist(); }
        catch (cause) {
          rollback();
          this.pending = pending;
          await this.persist().catch(() => {});
          throw cause;
        }
      }
      if (!response.ok) {
        try { await this.persist(); }
        catch (cause) { this.pending = pending; await this.persist().catch(() => {}); throw cause; }
      }
      if (refreshCatalog) {
        const conflict = this.edits.get(pending.key)?.conflict ?? (this.selected ? this.edits.get(this.selected)?.conflict : undefined);
        await this.refresh();
        if (conflict !== undefined) this.error = "The environment changed on its host. Both versions are preserved.";
      }
    } catch (cause) {
      this.error = `${this.pending ? "Save needs confirmation. Retry uses the original request. " : ""}${message(cause)}`;
    } finally { this.busy = false; this.changed(); }
  }

  private apply(pending: Pending, result: LocalEnvironmentSaveResult): () => void {
    const editor = this.edits.get(pending.key);
    if (!editor) throw new Error("The saved environment edit is no longer available.");
    const before = {
      configPath: editor.configPath, expectedRevision: editor.expectedRevision, dirty: editor.dirty,
      conflict: editor.conflict, selected: this.selected, notice: this.notice,
    };
    if (result.type === "conflict") {
      editor.conflict = result.current;
      this.error = "The environment changed on its host. Both versions are preserved.";
      return () => {
        editor.configPath = before.configPath;
        editor.expectedRevision = before.expectedRevision;
        editor.dirty = before.dirty || editor.version !== pending.version;
        if (before.conflict === undefined) delete editor.conflict; else editor.conflict = before.conflict;
        this.notice = before.notice;
      };
    }
    if (result.configPath !== pending.key && this.edits.has(result.configPath)) throw new Error("The host returned a configuration path that is already being edited.");
    editor.configPath = result.configPath;
    editor.expectedRevision = result.revision;
    if (editor.version === pending.version) { editor.raw = pending.envelope.command.action.raw; editor.dirty = false; }
    this.edits.delete(pending.key);
    this.edits.set(result.configPath, editor);
    if (this.selected === pending.key) this.selected = result.configPath;
    this.notice = editor.dirty ? "Saved. Newer edits remain unsaved." : "Environment saved.";
    return () => {
      if (result.configPath !== pending.key && this.edits.get(result.configPath) === editor) {
        this.edits.delete(result.configPath);
        this.edits.set(pending.key, editor);
      }
      editor.configPath = before.configPath;
      editor.expectedRevision = before.expectedRevision;
      editor.dirty = before.dirty || editor.version !== pending.version;
      if (before.conflict === undefined) delete editor.conflict; else editor.conflict = before.conflict;
      if (this.selected === result.configPath) this.selected = pending.key;
      else if (this.selected === before.selected) this.selected = before.selected;
      this.notice = before.notice;
    };
  }
}
