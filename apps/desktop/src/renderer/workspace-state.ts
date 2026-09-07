import type { CommandEnvelope, DesktopBridge, LocalEnvironmentActionsState } from "../../../../packages/shared/src/protocol";
import type { WorkspaceMutation, WorkspaceMutationResult, WorkspaceQuery, WorkspaceQueryResult, WorkspaceTarget } from "../../../../packages/shared/src/workspace-protocol";
import type { FileContent, GitBranch, GitDiff, GitStatus, GitWorktree, WorkspaceEntry } from "../../../../packages/shared/src/workspace";
import type { OfflineCache } from "./offline-cache";

type WorkspaceBridge = Pick<DesktopBridge, "workspaceQuery" | "command" | "subscribe" | "saveWorkspaceCopy">;
export const WORKSPACE_AUTOSAVE_DELAY_MS = 3_000;
export interface EditorDocument { discardedSaveId?: string; autosave?: boolean; saveError?: string; content: FileContent | null; text: string; dirty: boolean; conflict?: FileContent | null; recoveredText?: string }
export interface PendingWorkspaceMutation { envelope: CommandEnvelope & { command: { type: "workspace.mutate"; target: WorkspaceTarget; action: WorkspaceMutation } }; uncertain: boolean }
export const workspaceKey = (target: WorkspaceTarget) => "sessionId" in target ? `session:${target.sessionId}` : `project:${target.projectId}`;

/** Owner-scoped editor buffers and mutation receipts. Reads never replace an unsaved buffer. */
export class WorkspaceState {
  documents = new Map<string, EditorDocument>();
  directories = new Map<string, WorkspaceEntry[]>();
  directory = ".";
  opened?: string;
  status?: GitStatus;
  branches: GitBranch[] = [];
  worktrees: GitWorktree[] = [];
  diff?: GitDiff;
  diffSelection: { path?: string; staged: boolean } = { staged: false };
  errors: Record<string, string | undefined> = {};
  loading = new Set<string>();
  connected = false;
  restored = false;
  pending?: PendingWorkspaceMutation;
  busy = false;
  notice?: string;
  environmentActions?: LocalEnvironmentActionsState;
  mutationReceipt?: { commandId: string; value: WorkspaceMutationResult };
  cacheWarning?: string;
  commitMessage = "";
  private listeners = new Set<() => void>();
  private documentEpochs = new Map<string, number>();
  private inFlight = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private restoration?: Promise<void>;
  private unsubscribe?: () => void;
  private started = false;
  private autosaveTimer?: ReturnType<typeof setTimeout>;
  private autosaveRunning = false;
  private autosaveDue = new Map<string, number>();
  readonly cacheKey: string;
  constructor(private bridge: WorkspaceBridge, readonly hostId: string, readonly target: WorkspaceTarget, private cache: OfflineCache, private localHostId?: string) {
    this.cacheKey = `agent-desktop:workspace:v1:${hostId}:${workspaceKey(target)}`;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get canSaveCopy() { return Boolean(this.bridge.saveWorkspaceCopy); }
  saveCopy(path: string) {
    if (!this.connected) return Promise.reject(new Error("Reconnect to copy the file from its owning host."));
    if (!this.bridge.saveWorkspaceCopy) return Promise.reject(new Error("Save as is unavailable in this desktop build."));
    return this.bridge.saveWorkspaceCopy(this.target, path, this.hostId);
  }
  private changed() { for (const listener of this.listeners) listener(); this.scheduleAutosave(); }
  start() {
    this.started = true; this.scheduleAutosave();
    this.unsubscribe ??= this.bridge.subscribe(event => {
      if ((event.hostId ?? this.localHostId) !== this.hostId) return;
      if (event.type === "workspace" && workspaceKey(event.target) === workspaceKey(this.target)) void this.refresh();
    });
  }
  stop() { this.started = false; clearTimeout(this.autosaveTimer); this.unsubscribe?.(); this.unsubscribe = undefined; }
  restore(): Promise<void> {
    return this.restoration ??= (async () => {
      try {
        const saved = JSON.parse(await this.cache.read(this.cacheKey) ?? "null");
        if (saved?.version === 1) {
          for (const [path, document] of saved.documents ?? []) if (!this.documents.has(path) && typeof document?.text === "string") this.documents.set(path, document);
          for (const [path, entries] of saved.directories ?? []) if (!this.directories.has(path)) this.directories.set(path, entries);
          this.pending ??= saved.pending ? { ...saved.pending, uncertain: true } : undefined;
          this.commitMessage ||= saved.commitMessage ?? "";
          this.opened ??= saved.opened;
          this.status ??= saved.status;
        }
        this.restored = true; this.cacheWarning = undefined;
      } catch (cause) { this.cacheWarning = `Editor recovery storage could not be read. Mutations are paused to preserve any pending receipt. ${message(cause)}`; this.restoration = undefined; }
      this.changed();
    })();
  }
  private persist(): Promise<void> {
    if (!this.restored) return Promise.reject(new Error(this.cacheWarning ?? "Editor recovery is still loading."));
    const snapshot = JSON.stringify({ version: 1, documents: [...this.documents], directories: [...this.directories], pending: this.pending, commitMessage: this.commitMessage, opened: this.opened, status: this.status });
    const write = this.writes.catch(() => {}).then(() => this.cache.write(this.cacheKey, snapshot));
    this.writes = write;
    return write.then(() => { this.cacheWarning = undefined; this.changed(); }, cause => { this.cacheWarning = `Editor recovery could not be saved on this device. ${message(cause)}`; this.changed(); throw cause; });
  }
  private saveSoon() { void this.persist().catch(() => {}); }
  setConnected(connected: boolean) { this.connected = connected; this.changed(); }
  async query(query: WorkspaceQuery): Promise<WorkspaceQueryResult> {
    if (!this.connected) throw new Error("This host is disconnected. Cached workspace data may be out of date.");
    return this.bridge.workspaceQuery(this.target, query, this.hostId);
  }
  private load(key: string, operation: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(key)) { this.again.add(key); return this.inFlight.get(key)!; }
    this.loading.add(key); this.changed();
    const run = operation().then(() => { this.errors[key] = undefined; }, cause => { this.errors[key] = message(cause); }).finally(() => {
      this.loading.delete(key); this.inFlight.delete(key); this.changed();
      if (this.again.delete(key)) void this.load(key, operation);
    });
    this.inFlight.set(key, run); return run;
  }
  async refresh() {
    await this.restore();
    const reads = [this.list(this.directory), this.loadGit()];
    if (this.environmentActions !== undefined) reads.push(this.loadEnvironmentActions());
    if (this.opened) reads.push(this.read(this.opened));
    await Promise.allSettled(reads);
  }
  list(path: string) {
    this.directory = path; this.changed();
    return this.readDirectory(path);
  }
  /** Cache entries without navigating another panel’s directory browser. */
  readDirectory(path: string) {
    return this.load(`files:${path}`, async () => { const result = await this.query({ type: "files.list", path }); if (result.type !== "files.list") throw new Error("The host returned the wrong directory response."); this.directories.set(path, result.entries); this.saveSoon(); });
  }
  open(path: string) { this.opened = path; this.changed(); this.saveSoon(); return this.read(path); }
  read(path: string) {
    return this.load(`file:${path}`, async () => {
      const epoch = this.documentEpochs.get(path) ?? 0;
      let result: WorkspaceQueryResult;
      try { result = await this.query({ type: "file.read", path }); }
      catch (cause) { if ((this.documentEpochs.get(path) ?? 0) !== epoch) return; throw cause; }
      if (result.type !== "file.read") throw new Error("The host returned the wrong file response.");
      if ((this.documentEpochs.get(path) ?? 0) !== epoch) return;
      const previous = this.documents.get(path);
      if (previous?.dirty) {
        if (previous.content?.revision !== result.content.revision) previous.conflict = result.content;
      } else this.documents.set(path, { content: result.content, text: result.content.kind === "text" ? result.content.text : "", dirty: false, recoveredText: previous?.recoveredText, discardedSaveId: previous?.discardedSaveId });
      this.documentEpochs.set(path, epoch + 1);
      this.saveSoon();
    });
  }
  edit(path: string, text: string, autosave = false) { const item = this.documents.get(path); if (!item) return; item.text = text; item.discardedSaveId = undefined; if (autosave) { item.autosave = true; item.saveError = undefined; this.autosaveDue.set(path, Date.now() + WORKSPACE_AUTOSAVE_DELAY_MS); } item.dirty = item.content?.kind !== "text" || text !== item.content.text; this.documentEpochs.set(path, (this.documentEpochs.get(path) ?? 0) + 1); this.changed(); this.saveSoon(); }
  newFile(path: string) { if (!path || path.startsWith("/") || path.split("/").includes("..")) { this.errors.action = "Use a relative file path within this workspace."; this.changed(); return; } if (!this.documents.has(path)) { this.documents.set(path, { content: null, text: "", dirty: true, autosave: true }); this.autosaveDue.set(path, Date.now() + WORKSPACE_AUTOSAVE_DELAY_MS); this.documentEpochs.set(path, (this.documentEpochs.get(path) ?? 0) + 1); } this.opened = path; this.changed(); this.saveSoon(); }
  setCommitMessage(value: string) { this.commitMessage = value; this.changed(); this.saveSoon(); }
  resolve(path: string, choice: "local" | "remote") {
    const item = this.documents.get(path); if (!item || item.conflict === undefined) return;
    const current = item.conflict;
    if (choice === "local" && current && current.kind !== "text") { this.errors.action = "The host file is no longer editable UTF-8 text. Your buffer is preserved."; this.changed(); return; }
    if (choice === "remote") { item.recoveredText = item.text; item.text = current?.kind === "text" ? current.text : ""; }
    item.content = current; item.conflict = undefined; item.dirty = choice === "local"; item.saveError = undefined;
    this.autosaveDue.set(path, Date.now() + WORKSPACE_AUTOSAVE_DELAY_MS);
    this.documentEpochs.set(path, (this.documentEpochs.get(path) ?? 0) + 1);
    this.changed(); this.saveSoon();
  }
  loadEnvironmentActions() {
    return this.load("environment-actions", async () => {
      const result = await this.query({ type: "environment.actions" });
      if (result.type !== "environment.actions") throw new Error("The host returned the wrong environment actions response.");
      this.environmentActions = result.state;
    });
  }
  loadGit() {
    return this.load("git", async () => {
      const result = await this.query({ type: "git.status" });
      if (result.type !== "git.status") throw new Error("The host returned the wrong Git status response.");
      this.status = result.status; this.saveSoon();
      if (this.diffRequested) await this.loadDiff();
    });
  }
  loadWorktrees() {
    return this.load("worktrees", async () => {
      const results = await Promise.all([this.query({ type: "git.worktrees" }), this.query({ type: "git.branches" })]);
      if (results[0]!.type !== "git.worktrees" || results[1]!.type !== "git.branches") throw new Error("The host returned the wrong worktree response.");
      this.worktrees = results[0]!.worktrees; this.branches = results[1]!.branches;
    });
  }
  showDiff(path: string | undefined, staged: boolean) {
    this.diffRequested = true;
    this.diffSelection = { path, staged }; this.diff = undefined; this.changed();
    return this.loadDiff();
  }
  private diffRequested = false;
  private loadDiff() {
    return this.load("diff", async () => { const selection = this.diffSelection; const result = await this.query({ type: "git.diff", ...selection }); if (result.type !== "git.diff") throw new Error("The host returned the wrong diff response."); if (this.diffSelection === selection) this.diff = result.diff; });
  }
  saveFile(path: string) { const item = this.documents.get(path); if (!item || !item.dirty || item.conflict !== undefined) return Promise.resolve(); item.saveError = undefined; this.autosaveDue.set(path, Date.now() + WORKSPACE_AUTOSAVE_DELAY_MS); return this.mutate({ type: "file.write", path, text: item.text, expectedRevision: item.content?.revision ?? null, bom: item.content?.kind === "text" ? item.content.bom : false }); }
  /** Only new UI edits opt in. Older manual buffers never become writes on upgrade. */
  private scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    if (!this.started || !this.restored || !this.connected || this.cacheWarning || this.pending || this.busy || this.autosaveRunning) return;
    let selected: { path: string; due: number } | undefined;
    for (const [path, item] of this.documents) {
      if (!item.autosave || !item.dirty || item.saveError || item.conflict !== undefined || item.content && item.content.kind !== "text") continue;
      const due = this.autosaveDue.get(path) ?? Date.now() + WORKSPACE_AUTOSAVE_DELAY_MS;
      this.autosaveDue.set(path, due);
      if (!selected || due < selected.due) selected = { path, due };
    }
    if (!selected) return;
    const path = selected.path;
    this.autosaveTimer = setTimeout(() => {
      this.autosaveRunning = true;
      void this.saveFile(path).finally(() => { this.autosaveRunning = false; this.scheduleAutosave(); });
    }, Math.max(0, selected.due - Date.now()));
  }
  private async waitForMutation() {
    if (!this.busy) return;
    await new Promise<void>(resolve => { const off = this.subscribe(() => { if (!this.busy) { off(); resolve(); } }); });
  }
  /** Close uses the same receipt queue and drains newer edits; unresolved outcomes stop it. */
  async saveUntilClean(path: string): Promise<boolean> {
    await this.restore();
    if (!this.restored) return false;
    while (true) {
      await this.waitForMutation();
      const item = this.documents.get(path);
      if (!item?.dirty) return true;
      if (!this.restored || !this.connected || this.pending || this.cacheWarning || item.conflict !== undefined || item.content && item.content.kind !== "text") return false;
      await this.saveFile(path);
      if (this.pending || this.documents.get(path)?.saveError || this.errors.action || this.cacheWarning) return false;
    }
  }
  async discardFileEdits(path: string): Promise<boolean> {
    const item = this.documents.get(path); if (!item) return this.restored;
    const previous = { ...item };
    const current = item.conflict !== undefined ? item.conflict : item.content;
    item.content = current; item.text = current?.kind === "text" ? current.text : "";
    item.dirty = false; item.autosave = false; item.conflict = undefined; item.saveError = undefined;
    item.discardedSaveId = this.pending?.envelope.command.action.type === "file.write" && this.pending.envelope.command.action.path === path ? this.pending.envelope.id : undefined;
    this.autosaveDue.delete(path);
    const epoch = (this.documentEpochs.get(path) ?? 0) + 1;
    this.documentEpochs.set(path, epoch);
    // Do not report clean to a close observer until the discard is durable.
    try { await this.persist(); return this.documents.get(path) === item && !item.dirty; }
    catch {
      if (this.documents.get(path) === item && this.documentEpochs.get(path) === epoch) {
        this.documents.set(path, previous); this.documentEpochs.set(path, epoch + 1);
      }
      this.changed(); return false;
    }
  }
  private fileSaveError(action: WorkspaceMutation, error: string) {
    if (action.type === "file.write") { const item = this.documents.get(action.path); if (item) item.saveError = error; }
  }
  async mutate(action: WorkspaceMutation): Promise<boolean> {
    await this.restore();
    if (this.busy || this.pending) return false;
    if (!this.restored) return false;
    if (!this.connected) { this.errors.action = "Reconnect to change files or Git state on this host."; this.changed(); await this.persist().catch(() => {}); return false; }
    this.pending = { envelope: { id: crypto.randomUUID(), command: { type: "workspace.mutate", target: this.target, action } }, uncertain: false };
    await this.deliver();
    return true;
  }
  async retry() { if (this.pending && !this.busy) await this.deliver(); }
  async acknowledgeUnknown() { if (this.busy || !this.pending?.uncertain) return; this.pending = undefined; this.errors.action = undefined; this.notice = "Previous outcome acknowledged. Review the current files and Git state before a new change."; this.changed(); await this.persist().catch(() => {}); }
  private async deliver() {
    const item = this.pending; if (!item || !this.connected) return;
    this.busy = true; this.errors.action = undefined; this.notice = undefined; this.changed();
    try {
      await this.restore(); await this.persist(); // Never deliver without a recoverable original command ID.
      const result = await this.bridge.command(item.envelope, this.hostId);
      if (result.commandId !== item.envelope.id) throw new Error("The host returned a receipt for a different command.");
      if (!result.ok) {
        if (result.error.code === "OUTCOME_UNKNOWN") throw new Error(result.error.message);
        this.pending = undefined; this.errors.action = result.error.message;
        const action = item.envelope.command.action, document = action.type === "file.write" ? this.documents.get(action.path) : undefined;
        if (document?.discardedSaveId === item.envelope.id) { document.discardedSaveId = undefined; document.saveError = undefined; }
        else this.fileSaveError(action, result.error.message);
      } else {
        const value = result.value;
        if (!value || !("type" in value) || value.type !== item.envelope.command.action.type) throw new Error("The host did not return the expected mutation receipt.");
        this.applyResult(item.envelope.command.action, value, item.envelope.id); this.mutationReceipt = { commandId: item.envelope.id, value }; this.pending = undefined;
      }
      await this.persist();
    } catch (cause) {
      if (this.pending) this.pending.uncertain = true;
      this.errors.action = this.pending ? `Delivery needs confirmation. Retry checks the original command. ${message(cause)}` : `The host replied, but its recovery receipt could not be saved. ${message(cause)}`;
      this.fileSaveError(item.envelope.command.action, this.errors.action!);
      this.saveSoon();
    } finally { this.busy = false; this.changed(); await this.refresh(); }
  }
  private applyResult(action: WorkspaceMutation, value: WorkspaceMutationResult, commandId: string) {
    if (value.type === "environment.select") this.environmentActions = value.state;
    else if (action.type === "file.write" && value.type === "file.write") {
      const item = this.documents.get(action.path); if (!item) return;
      this.documentEpochs.set(action.path, (this.documentEpochs.get(action.path) ?? 0) + 1);
      if (item.discardedSaveId === commandId) {
        const content = value.result.ok ? value.result.document : value.result.current;
        item.content = content; item.text = content?.kind === "text" ? content.text : "";
        item.dirty = false; item.conflict = undefined; item.saveError = undefined; item.discardedSaveId = undefined;
        this.notice = "Original save outcome checked. Discarded edits remain discarded.";
        return;
      }
      if (!value.result.ok) { item.conflict = value.result.current; this.errors.action = "The file changed on the host. Both versions are preserved below."; return; }
      const newer = item.text !== action.text;
      item.content = value.result.document; item.conflict = undefined; item.saveError = undefined;
      this.autosaveDue.set(action.path, Date.now() + WORKSPACE_AUTOSAVE_DELAY_MS);
      if (!newer) item.text = value.result.document.text;
      item.dirty = item.text !== value.result.document.text;
      this.notice = newer ? "Saved the submitted version. Your newer edits remain unsaved." : "File saved on the owning host.";
    } else if (value.type === "git.checkout") { this.status = value.status; this.notice = `Switched to ${value.status.branch ?? "detached HEAD"}.`; void this.loadWorktrees(); }
    else if (value.type === "git.stage" || value.type === "git.unstage") { this.status = value.status; this.notice = value.type === "git.stage" ? "Selected paths staged." : "Selected paths unstaged."; }
    else if (value.type === "git.commit" && action.type === "git.commit") { if (this.commitMessage === action.message) this.commitMessage = ""; this.notice = value.summary || `Committed ${value.commit}`; }
    else if (value.type === "worktree.create") { this.notice = `Created worktree ${value.worktree.path}`; void this.loadWorktrees(); }
    else if (value.type === "worktree.remove") { this.notice = "Managed worktree removed."; void this.loadWorktrees(); }
  }
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
