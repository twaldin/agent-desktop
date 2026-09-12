import { BranchQueryObserver } from "./branch-query-observer";
import type { LiveBranchQuery, BranchQueryObserverView } from "@agent-desktop/shared";
import { branchQueryTypes, repositoryChangeAffects, type BranchQueryType } from "@agent-desktop/shared";
import { RepositoryWatchRetention } from "./repository-watch-retention";
import type { RepositoryWatchView } from "@agent-desktop/shared";
import type { CommandEnvelope, DesktopBridge, LocalEnvironmentActionsState } from "../../../../packages/shared/src/protocol";
import type { WorkspaceMutation, WorkspaceMutationResult, WorkspaceQuery, WorkspaceQueryResult, WorkspaceTarget } from "../../../../packages/shared/src/workspace-protocol";
import { parseStandaloneFilePath } from "../../../../packages/shared/src/workspace";
import type { FileContent, GitActionContext, GitBranch, GitDiff, GitStatus, GitWorktree, WorkspaceEntry } from "../../../../packages/shared/src/workspace";
import type { GitSubmissionIntent, GitSubmissionReceipt } from "../../../../packages/shared/src/git-submissions";
import { isGitCheckoutAction, readGitCheckoutRefusal, type GitCheckoutRefusal } from "../../../../packages/shared/src/checkout-refusal";
import type { OfflineCache } from "./offline-cache";

type WorkspaceBridge = Pick<DesktopBridge, "workspaceQuery" | "command" | "subscribe" | "saveWorkspaceCopy" | "acquireWorkspaceImage" | "releaseWorkspaceImage" | "repositoryWatch" | "subscribeRepositoryWatch" | "branchQuery" | "subscribeBranchQuery">;
export const WORKSPACE_AUTOSAVE_DELAY_MS = 3_000;
export interface EditorDocument { discardedSaveId?: string; autosave?: boolean; saveError?: string; content: FileContent | null; text: string; dirty: boolean; conflict?: FileContent | null; recoveredText?: string }
export interface PendingWorkspaceMutation { envelope: CommandEnvelope & { command: { type: "workspace.mutate"; target: WorkspaceTarget; action: WorkspaceMutation } }; uncertain: boolean }
export const workspaceKey = (target: WorkspaceTarget) => "filePath" in target ? `file:${encodeURIComponent(target.filePath)}` : "sessionId" in target ? `session:${target.sessionId}` : `project:${target.projectId}`;

/** Owner-scoped editor buffers and mutation receipts. Reads never replace an unsaved buffer. */
export class WorkspaceState {
  documents = new Map<string, EditorDocument>();
  directories = new Map<string, WorkspaceEntry[]>();
  directory = ".";
  opened?: string;
  status?: GitStatus;
  /** Set only by the host's discriminated status response; ordinary Git errors remain visible. */
  gitAvailability: "unknown" | "repository" | "not-repository" = "unknown";
  branches: GitBranch[] = [];
  worktrees: GitWorktree[] = [];
  diff?: GitDiff;
  diffSelection: { path?: string; staged: boolean } = { staged: false };
  errors: Record<string, string | undefined> = {};
  loading = new Set<string>();
  connected = false;
  imageGeneration = 0;
  /** Observed owner invalidations, independent of the HEAD/index mutation revision. */
  repositoryInvalidation = 0;
  private repositoryQueryVersions = new Map<BranchQueryType, number>();
  repositoryQueryRevision(query: BranchQueryType): number { return this.repositoryQueryVersions.get(query) ?? 0; }
  private invalidateRepository(kind?: unknown) {
    // Admission owners still observe every repository change. Query data only
    // refreshes for its own dependency family; unknown/legacy events affect all.
    this.repositoryInvalidation++;
    for (const query of branchQueryTypes) if (repositoryChangeAffects(query, kind))
      this.repositoryQueryVersions.set(query, this.repositoryQueryRevision(query) + 1);
  }
  restored = false;
  pending?: PendingWorkspaceMutation;
  busy = false;
  notice?: string;
  environmentActions?: LocalEnvironmentActionsState;
  mutationReceipt?: { commandId: string; value: WorkspaceMutationResult };
  checkoutRefusal?: GitCheckoutRefusal;
  cacheWarning?: string;
  commitMessage = "";
  includeUnstaged = true;
  gitActionContext?: GitActionContext;
  gitSubmission?: GitSubmissionReceipt;
  private repositoryWatch?: RepositoryWatchRetention;
  private watchView?: RepositoryWatchView;
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
  private submissionRead = 0;
  private submissionControlBusy = false;
  private gitSubmissionObserved = false;
  readonly cacheKey: string;
  constructor(private bridge: WorkspaceBridge, readonly hostId: string, readonly target: WorkspaceTarget, private cache: OfflineCache, private localHostId?: string) {
    if ("filePath" in target) parseStandaloneFilePath(target.filePath);
    this.cacheKey = `agent-desktop:workspace:v1:${hostId}:${workspaceKey(target)}`;
  }
  get repositoryWatchView(): RepositoryWatchView | undefined { return this.watchView && { ...this.watchView }; }
  get repositoryWatchWarning(): string | undefined {
    const view = this.watchView;
    if (!view || view.phase === "connecting" || view.phase === "pending" || view.phase === "released") return;
    if (view.phase === "ready") return view.error ? `Live updates may be incomplete. ${view.error}` : undefined;
    return `Live updates are unavailable. ${view.error ?? "Reconnect to restore repository watching."}`;
  }
  createBranchQueryObserver(query: LiveBranchQuery, listener: (view: BranchQueryObserverView) => void): BranchQueryObserver {
    if ("filePath" in this.target) throw new Error("Standalone files do not have a branch query owner.");
    return new BranchQueryObserver(this.bridge, this.hostId, this.target, query, listener);
  }
  retainRepositoryWatch(): () => void {
    if ("filePath" in this.target) {
      this.observeWatch({ phase: "unsupported", error: "A standalone file does not own a repository watch." });
      return () => {};
    }
    this.repositoryWatch ??= new RepositoryWatchRetention(this.bridge, this.hostId, this.target);
    return this.repositoryWatch.retain(view => this.observeWatch(view));
  }
  private observeWatch(view: RepositoryWatchView) {
    const prior = this.watchView;
    if (prior?.phase === view.phase && prior.error === view.error) return;
    this.watchView = { ...view };
    // A first post-watch read closes the gap after an ordinary initial read.
    // Loss/failure invalidates live eligibility, without forbidding one-shot reads.
    // Internal retirement precedes failure; released itself must not refresh twice.
    if (view.phase !== "released" && (view.phase === "ready" || prior?.phase === "ready" || view.phase === "failed"
      || view.phase === "unsupported" || view.phase === "disconnected")) this.invalidateRepository();
    this.changed();
  }
  get standalonePath() { return "filePath" in this.target ? this.target.filePath : undefined; }
  get standaloneName() { return this.standalonePath?.split("/").at(-1); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get canSaveCopy() { return Boolean(this.bridge.saveWorkspaceCopy); }
  get gitSubmissionBlocked() { return this.hasGitSubmissionFence(); }
  get gitSubmissionControlInFlight() { return this.submissionControlBusy; }
  saveCopy(path: string) {
    if (!this.connected) return Promise.reject(new Error("Reconnect to copy the file from its owning host."));
    if (!this.bridge.saveWorkspaceCopy) return Promise.reject(new Error("Save as is unavailable in this desktop build."));
    return this.bridge.saveWorkspaceCopy(this.target, path, this.hostId);
  }
  async acquireImage(path: string) {
    if (!this.connected) throw new Error("Reconnect to load this workspace image.");
    if (!this.bridge.acquireWorkspaceImage || !this.bridge.releaseWorkspaceImage) throw new Error("Workspace image loading is unavailable in this desktop.");
    const release = this.bridge.releaseWorkspaceImage.bind(this.bridge);
    const absolute = this.standalonePath ? parseStandaloneFilePath(path.startsWith("/") ? path : this.standalonePath.slice(0,this.standalonePath.lastIndexOf("/")+1)+path) : undefined;
    const lease = await this.bridge.acquireWorkspaceImage(absolute ? {filePath:absolute} : this.target, absolute ? path.split("/").at(-1)! : path, this.hostId);
    return { url: lease.url, release: () => release(lease.id) };
  }
  private changed() { for (const listener of this.listeners) listener(); this.scheduleAutosave(); }
  start() {
    this.started = true; this.scheduleAutosave();
    this.unsubscribe ??= this.bridge.subscribe(event => {
      if ((event.hostId ?? this.localHostId) !== this.hostId) return;
      if (event.type === "workspace" && workspaceKey(event.target) === workspaceKey(this.target)) {
        this.invalidateRepository(event.repositoryChange); this.changed();
        void this.refresh();
      }
    });
  }
  stop() { this.started = false; clearTimeout(this.autosaveTimer); this.unsubscribe?.(); this.unsubscribe = undefined; }
  restore(): Promise<void> {
    return this.restoration ??= (async () => {
      try {
        const saved = JSON.parse(await this.cache.read(this.cacheKey) ?? "null");
        if (saved?.version === 1) {
          const pendingCommand = saved.pending?.envelope?.command;
          if (saved.pending && (!pendingCommand?.target || workspaceKey(pendingCommand.target) !== workspaceKey(this.target)))
            throw new Error("The recovered command belongs to a different file or workspace.");
          if (this.standaloneName) {
            if ((saved.documents ?? []).some(([path]: [string]) => path !== this.standaloneName)
              || (saved.opened !== undefined && saved.opened !== this.standaloneName)
              || (saved.directories?.length ?? 0) > 0
              || pendingCommand && (pendingCommand.type !== "workspace.mutate"
                || !["file.write", "file.open"].includes(pendingCommand.action?.type)
                || pendingCommand.action.path !== this.standaloneName))
              throw new Error("The recovered editor state exceeds this file's scope.");
          }
          for (const [path, document] of saved.documents ?? []) if (!this.documents.has(path) && typeof document?.text === "string") this.documents.set(path, document);
          for (const [path, entries] of saved.directories ?? []) if (!this.directories.has(path)) this.directories.set(path, entries);
          this.pending ??= saved.pending ? { ...saved.pending, uncertain: true } : undefined;
          this.commitMessage ||= saved.commitMessage ?? "";
          if (typeof saved.includeUnstaged === "boolean") this.includeUnstaged = saved.includeUnstaged;
          if (isReceiptFor(saved.gitSubmission, this.hostId, this.target)) this.gitSubmission = saved.gitSubmission;
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
    const snapshot = JSON.stringify({ version: 1, documents: [...this.documents], directories: [...this.directories], pending: this.pending, commitMessage: this.commitMessage, includeUnstaged: this.includeUnstaged, gitSubmission: this.gitSubmission, opened: this.opened, status: this.status });
    const write = this.writes.catch(() => {}).then(() => this.cache.write(this.cacheKey, snapshot));
    this.writes = write;
    return write.then(() => { this.cacheWarning = undefined; this.changed(); }, cause => { this.cacheWarning = `Editor recovery could not be saved on this device. ${message(cause)}`; this.changed(); throw cause; });
  }
  private saveSoon() { void this.persist().catch(() => {}); }
  setConnected(connected: boolean) { if (connected && !this.connected) this.imageGeneration++; this.connected = connected; this.changed(); }
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
    if(this.standaloneName) { await this.read(this.standaloneName); return; }
    const reads = [this.list(this.directory), this.loadGit()];
    if (this.gitActionContext !== undefined) reads.push(this.loadGitActionContext());
    if (this.gitSubmissionObserved || this.gitSubmission || isGitSubmit(this.pending?.envelope.command.action)) reads.push(this.loadGitSubmission());
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
      // File-link navigation can reveal a cached buffer while its host is offline.
      // A missing buffer still takes the normal disconnected-error path.
      if (!this.connected && this.documents.has(path)) return;
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
      this.gitAvailability = result.availability ?? "repository";
      if (result.availability === "not-repository") {
        this.status = undefined; this.branches = []; this.worktrees = []; this.diff = undefined; this.diffRequested = false; this.saveSoon();
        return;
      }
      this.status = result.status; this.saveSoon();
      if (this.diffRequested) await this.loadDiff();
    });
  }
  loadGitActionContext() {
    return this.load("git-action-context", async () => {
      const result = await this.query({ type: "git.action-context" });
      if (result.type !== "git.action-context") throw new Error("The host returned the wrong Git action context response.");
      this.gitActionContext = result.context;
    });
  }
  loadGitSubmission() {
    if (this.standaloneName) return Promise.resolve();
    this.gitSubmissionObserved = true;
    ++this.submissionRead;
    return this.load("git-submission", async () => {
      const read = this.submissionRead;
      const expected = isGitSubmit(this.pending?.envelope.command.action) ? this.pending!.envelope.id : undefined;
      const result = await this.query({ type: "git.submission", ...(expected ? { commandId: expected } : {}) });
      if (result.type !== "git.submission") throw new Error("The host returned the wrong Git submission response.");
      if (read !== this.submissionRead || !result.receipt) return;
      if (!isReceiptFor(result.receipt, this.hostId, this.target) || expected && result.receipt.commandId !== expected)
        throw new Error("The host returned a Git submission for another workspace or command.");
      if (!this.acceptGitSubmission(result.receipt)) return;
      if (expected && isSettled(result.receipt.outcome)) this.settleGitSubmission(result.receipt);
      this.saveSoon();
    });
  }
  setIncludeUnstaged(includeUnstaged: boolean) { this.includeUnstaged = includeUnstaged; this.changed(); this.saveSoon(); }
  async submitGit(intent: GitSubmissionIntent): Promise<boolean> {
    if (this.standaloneName) return false;
    return this.mutate({ type: "git.submit", intent }, 10);
  }
  async cancelGitSubmission(): Promise<boolean> {
    const receipt = this.gitSubmission;
    if (!receipt || !isReceiptFor(receipt, this.hostId, this.target) || isTerminal(receipt.outcome)) return false;
    return this.sendGitSubmissionControl("git.submit.cancel", receipt.commandId);
  }
  async acknowledgeGitSubmission(): Promise<boolean> {
    const receipt = this.gitSubmission;
    if (!receipt || !isReceiptFor(receipt, this.hostId, this.target) || receipt.outcome !== "unknown") return false;
    return this.sendGitSubmissionControl("git.submit.acknowledge", receipt.commandId);
  }
  private async sendGitSubmissionControl(type: "git.submit.cancel" | "git.submit.acknowledge", commandId: string): Promise<boolean> {
    if (!this.connected || this.submissionControlBusy) return false;
    const envelope: CommandEnvelope & { command: { type: "workspace.mutate"; target: WorkspaceTarget; action: Extract<WorkspaceMutation, { type: typeof type }> } } = {
      id: crypto.randomUUID(), commandVersion: 10, command: { type: "workspace.mutate", target: this.target, action: { type, commandId } },
    };
    this.submissionControlBusy = true; this.errors.action = undefined; this.changed();
    try {
      const result = await this.bridge.command(envelope, this.hostId);
      const value = result.ok ? result.value as WorkspaceMutationResult | undefined : undefined;
      if (result.commandId !== envelope.id || !result.ok || value?.type !== type) throw new Error(result.ok ? "The host returned the wrong Git submission receipt." : result.error.message);
      const receipt = value.receipt;
      if (!isReceiptFor(receipt, this.hostId, this.target) || receipt.commandId !== commandId) throw new Error("The host returned a Git submission for another workspace or command.");
      if (this.gitSubmission && this.gitSubmission.commandId !== commandId) return false;
      if (!this.acceptGitSubmission(receipt)) return false;
      if (type === "git.submit.acknowledge" && receipt.outcome === "unknown" && typeof receipt.acknowledgedAt === "number" && this.pending?.envelope.id === commandId) this.pending = undefined;
      if (type === "git.submit.cancel" && isSettled(receipt.outcome) && this.pending?.envelope.id === commandId) this.settleGitSubmission(receipt);
      await this.persist(); return true;
    } catch (cause) { this.errors.action = message(cause); this.saveSoon(); return false; }
    finally { this.submissionControlBusy = false; this.changed(); }
  }
  loadWorktrees() {
    if (this.gitAvailability === "not-repository") return Promise.resolve();
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
    if (!this.started || !this.restored || !this.connected || this.cacheWarning || this.pending || this.busy || this.hasGitSubmissionFence() || this.autosaveRunning) return;
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
  private async waitForMutation(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.busy) return;
    await new Promise<void>((resolve, reject) => {
      const clean = () => { off(); signal?.removeEventListener("abort", cancel); };
      const cancel = () => { clean(); reject(signal?.reason); };
      const off = this.subscribe(() => { if (!this.busy) { clean(); resolve(); } });
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
  /** Close uses the same receipt queue and drains newer edits; unresolved outcomes stop it. */
  async saveUntilClean(path: string, signal?: AbortSignal): Promise<boolean> {
    await this.restore();
    if (!this.restored) return false;
    while (true) {
      await this.waitForMutation(signal);
      signal?.throwIfAborted();
      const item = this.documents.get(path);
      if (!item?.dirty) return true;
      if (!this.restored || !this.connected || this.pending || this.hasGitSubmissionFence() || this.cacheWarning || item.conflict !== undefined || item.content && item.content.kind !== "text") return false;
      signal?.throwIfAborted();
      await this.saveFile(path);
      signal?.throwIfAborted();
      if (this.pending || this.hasGitSubmissionFence() || this.documents.get(path)?.saveError || this.errors.action || this.cacheWarning) return false;
    }
  }
  /** Normal window shutdown drains opted-in saves; offline/manual buffers stay recoverable. */
  async prepareWindowClose(signal?: AbortSignal): Promise<boolean> {
    await this.restore();
    signal?.throwIfAborted();
    if (!this.restored) return false;
    for (const [path, document] of this.documents) {
      signal?.throwIfAborted();
      if (document.autosave && document.dirty && this.connected && !await this.saveUntilClean(path, signal)) return false;
    }
    signal?.throwIfAborted();
    await this.persist();
    signal?.throwIfAborted();
    return true;
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
  async mutate(action: WorkspaceMutation, commandVersion?: CommandEnvelope["commandVersion"]): Promise<boolean> {
    return (await this.mutateCommand(action, commandVersion)) !== undefined;
  }
  /** Returns the admitted original ID even when its response needs inspection.
   * The guard is evaluated after restore, before taking ownership of a command.
   * Already-admitted work is not cancelled by later navigation. */
  async mutateCommand(action: WorkspaceMutation, commandVersion?: CommandEnvelope["commandVersion"], canAdmit: () => boolean = () => true): Promise<string | undefined> {
    await this.restore();
    if (!canAdmit() || this.busy || this.pending || this.hasGitSubmissionFence()) return;
    if (!this.restored) return;
    if (!this.connected) { this.errors.action = "Reconnect to change files or Git state on this host."; this.changed(); await this.persist().catch(() => {}); return; }
    if (isGitSubmit(action)) ++this.submissionRead;
    this.checkoutRefusal = undefined;
    this.pending = { envelope: { id: crypto.randomUUID(), ...(commandVersion ? { commandVersion } : {}), command: { type: "workspace.mutate", target: this.target, action: isGitCheckoutAction(action) ? structuredClone(action) : action } }, uncertain: false };
    const id = this.pending.envelope.id;
    await this.deliver();
    return id;
  }
  async retry() { if (this.pending && !this.busy) await this.deliver(); }
  async acknowledgeUnknown() {
    if (this.busy || !this.pending?.uncertain || isGitSubmit(this.pending.envelope.command.action)) return;
    this.pending = undefined; this.errors.action = undefined; this.notice = "Previous outcome acknowledged. Review the current files and Git state before a new change."; this.changed(); await this.persist().catch(() => {});
  }
  private async deliver() {
    const item = this.pending; if (!item || !this.connected) return;
    let refusal: GitCheckoutRefusal | undefined;
    this.busy = true; this.errors.action = undefined; this.notice = undefined; this.changed();
    try {
      await this.restore(); await this.persist(); // Never deliver without a recoverable original command ID.
      const result = await this.bridge.command(item.envelope, this.hostId);
      if (result.commandId !== item.envelope.id) throw new Error("The host returned a receipt for a different command.");
      if (!result.ok) {
        if (result.error.code === "OUTCOME_UNKNOWN") throw new Error(result.error.message);
        const conflict = readGitCheckoutRefusal(result.error);
        if (conflict) {
          if (!isGitCheckoutAction(item.envelope.command.action)) throw new Error("The host returned a checkout refusal for another action.");
          refusal = { commandId: item.envelope.id, action: structuredClone(item.envelope.command.action), error: conflict };
        }
        this.pending = undefined; this.errors.action = result.error.message;
        const action = item.envelope.command.action, document = action.type === "file.write" ? this.documents.get(action.path) : undefined;
        if (document?.discardedSaveId === item.envelope.id) { document.discardedSaveId = undefined; document.saveError = undefined; }
        else this.fileSaveError(action, result.error.message);
      } else {
        const value = result.value;
        if (!value || !("type" in value) || value.type !== item.envelope.command.action.type) throw new Error("The host did not return the expected mutation receipt.");
        if (value.type === "git.submit") {
          const receipt = value.receipt;
          if (!isReceiptFor(receipt, this.hostId, this.target) || receipt.commandId !== item.envelope.id) throw new Error("The host returned a Git submission for another workspace or command.");
          if (this.acceptGitSubmission(receipt)) {
            if (isSettled(receipt.outcome)) this.settleGitSubmission(receipt);
            else if (this.pending) this.pending.uncertain = receipt.outcome === "unknown";
          }
        } else {
          this.applyResult(item.envelope.command.action, value, item.envelope.id); this.mutationReceipt = { commandId: item.envelope.id, value }; this.pending = undefined;
        }
      }
      await this.persist();
      if (refusal) this.checkoutRefusal = refusal;
    } catch (cause) {
      // A failed local acknowledgement retains the original request for a
      // read of its durable host receipt, never a new checkout command.
      if (refusal) this.pending = item;
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
    } else if ((value.type === "git.checkout" || value.type === "git.checkout-ref" || value.type === "git.checkout-revision")) { this.status = value.status; this.notice = `Switched to ${value.status.branch ?? "detached HEAD"}.`; void this.loadWorktrees(); }
    else if (value.type === "git.stage" || value.type === "git.unstage") { this.status = value.status; this.notice = value.type === "git.stage" ? "Selected paths staged." : "Selected paths unstaged."; }
    else if (value.type === "git.commit" && action.type === "git.commit") { if (this.commitMessage === action.message) this.commitMessage = ""; this.notice = value.summary || `Committed ${value.commit}`; }
    else if (value.type === "worktree.create") { this.notice = `Created worktree ${value.worktree.path}`; void this.loadWorktrees(); }
    else if (value.type === "worktree.remove") { this.notice = "Managed worktree removed."; void this.loadWorktrees(); }
  }
  private acceptGitSubmission(receipt: GitSubmissionReceipt) {
    const current = this.gitSubmission;
    if (current?.commandId === receipt.commandId && receipt.revision < current.revision) return false;
    this.gitSubmission = receipt;
    return true;
  }
  private hasGitSubmissionFence() { return this.gitSubmission?.outcome === "pending" || this.gitSubmission?.outcome === "unknown" && !this.gitSubmission.acknowledgedAt; }
  private settleGitSubmission(receipt: GitSubmissionReceipt) {
    const action = this.pending?.envelope.command.action;
    if (this.pending?.envelope.id === receipt.commandId) this.pending = undefined;
    if (action?.type === "git.submit" && receipt.commit && this.commitMessage === action.intent.message) this.commitMessage = "";
    this.notice = receipt.outcome === "succeeded" ? receipt.commit?.summary ?? "Git submission completed." : receipt.error?.message;
  }
}
function isGitSubmit(action: WorkspaceMutation | undefined): action is Extract<WorkspaceMutation, { type: "git.submit" }> { return action?.type === "git.submit"; }
function isTerminal(outcome: GitSubmissionReceipt["outcome"]) { return outcome !== "pending"; }
function isSettled(outcome: GitSubmissionReceipt["outcome"]) { return outcome === "succeeded" || outcome === "failed" || outcome === "cancelled"; }
function isReceiptFor(receipt: unknown, hostId: string, target: WorkspaceTarget): receipt is GitSubmissionReceipt {
  if (!receipt || typeof receipt !== "object") return false;
  const value = receipt as GitSubmissionReceipt;
  if (value.hostId !== hostId || typeof value.commandId !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !["pending", "succeeded", "failed", "cancelled", "unknown"].includes(value.outcome)
    || !["queued", "branch", "preparing", "generating", "committing", "pushing", "completed"].includes(value.phase)
    || !value.target || typeof value.target !== "object" || !("projectId" in value.target || "sessionId" in value.target)) return false;
  try { return workspaceKey(value.target) === workspaceKey(target); } catch { return false; }
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
