import type { GitFileBlameLine, GitFileBlameUnavailable, GitFileCommit, GitFileHistoryCursor, GitFileInspection, GitFileLocation, GitFileRevision, GitFileOrigin } from "@agent-desktop/shared";
import type { WorkspaceState } from "./workspace-state";

const sameLocation = (left: GitFileLocation, right: GitFileLocation) => left.commit === right.commit && left.path === right.path;
export const gitFileBlameUnavailableText: Record<GitFileBlameUnavailable, string> = {
  missing: "This path does not exist at this commit (it may have been deleted, renamed or never tracked).",
  "not-regular-file": "Only regular Git blobs support source history (not directories, symlinks or submodules).",
  "too-large": "This revision exceeds the host text limit.",
  binary: "Binary revisions do not have text blame.",
  "unsupported-encoding": "This revision's encoding is unsupported.",
};
export interface PierreGitBlame {
  lines: GitFileBlameLine[];
  snapshotText: string;
  unavailable?: string;
  open(line: GitFileBlameLine): void;
}

/** One original owner/file. Historical documents never enter WorkspaceState.documents or its save queue. */
export class GitFileHistoryState {
  enabled = false;
  busy = false;
  error?: string;
  inspection?: GitFileInspection;
  commits: GitFileCommit[] = [];
  next: GitFileHistoryCursor | null = null;
  selected?: GitFileRevision;
  reveal?: { id: string; line: number };
  private generation = 0;
  private invalidation = -1;
  private listeners = new Set<() => void>();
  private revisions = new Map<string, GitFileRevision>();
  constructor(readonly data: WorkspaceState, readonly path: string) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  dispose() { this.generation++; this.listeners.clear(); }
  get stale() { return this.inspection !== undefined && this.invalidation !== this.data.repositoryInvalidation; }
  get workingMatches() {
    const content = this.inspection?.revision?.content, document = this.data.documents.get(this.path);
    return !this.inspection?.workingUnavailable && content?.kind === "text" && document?.content?.kind === "text" && document.content.revision === content.revision && document.text === content.text && document.conflict === undefined;
  }
  get blame(): PierreGitBlame | undefined {
    const revision = this.inspection?.revision;
    if (!this.enabled || !revision || revision.content?.kind !== "text") return;
    return { lines: revision.blame, snapshotText: revision.content.text,
      unavailable: !this.data.connected ? "Offline · blame is a cached commit snapshot." : this.stale ? "Repository changed · refresh blame." : !this.workingMatches ? "Working/editor text differs from this commit · inspect the committed snapshot for blame." : revision.blameUnavailable ? gitFileBlameUnavailableText[revision.blameUnavailable] : undefined,
      open: line => { void this.openRevision({ commit: line.commit, path: line.path }, line.originalLine); } };
  }
  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) { this.generation++; this.busy = false; this.selected = undefined; }
    this.changed();
    if (this.enabled && !this.inspection) void this.refresh();
  }
  async refresh(expression = "HEAD") {
    if (this.busy || !this.enabled) return;
    const generation = ++this.generation, invalidation = this.data.repositoryInvalidation;
    this.busy = true; this.error = undefined; this.changed();
    try {
      const result = await this.data.query({ type: "git.file-inspect", path: this.path, expression });
      if (generation !== this.generation) return;
      if (!this.data.connected) throw new Error("The original host disconnected during the history read. Cached results are retained.");
      if (result.type !== "git.file-inspect" || result.inspection.requested.path !== this.path || result.inspection.requested.expression !== expression) throw new Error("The host returned history for a different file or reference.");
      this.inspection = result.inspection; this.invalidation = invalidation;
      this.commits = result.inspection.history?.commits ?? []; this.next = result.inspection.history?.next ?? null;
      this.selected = undefined; this.reveal = undefined; this.revisions.clear();
      if (result.inspection.revision) this.remember(result.inspection.revision);
    } catch (error) { if (generation === this.generation) this.error = error instanceof Error ? error.message : "Could not read Git file history."; }
    finally { if (generation === this.generation) { this.busy = false; this.changed(); } }
  }
  private remember(revision: GitFileRevision) { this.revisions.set(`${revision.location.commit}:${revision.location.path}`, revision); }
  private assertOrigin(origin: GitFileOrigin) {
    const expected = this.inspection?.origin;
    if (!expected || !sameLocation(origin, expected) || origin.repositoryId !== expected.repositoryId || origin.workspacePath !== expected.workspacePath || origin.expression !== expected.expression) throw new Error("The host returned a different repository or original file identity.");
  }
  async loadOlder() {
    const origin = this.inspection?.origin, start = this.next;
    if (this.busy || !origin || !start) return;
    const generation = ++this.generation;
    this.busy = true; this.error = undefined; this.changed();
    try {
      const result = await this.data.query({ type: "git.file-history", origin, start });
      if (generation !== this.generation) return;
      if (!this.data.connected) throw new Error("The original host disconnected. Reconnect to load older history.");
      if (result.type !== "git.file-history" || !sameLocation(result.history.start, start) || result.history.start.offset !== start.offset || result.history.start.pending.length !== start.pending.length || !result.history.start.pending.every((location, index) => sameLocation(location, start.pending[index]!))) throw new Error("The host returned a different history page.");
      this.assertOrigin(result.history.origin);
      this.commits = [...this.commits, ...result.history.commits]; this.next = result.history.next;
    } catch (error) { if (generation === this.generation) this.error = error instanceof Error ? error.message : "Could not load older history."; }
    finally { if (generation === this.generation) { this.busy = false; this.changed(); } }
  }
  async openRevision(location: GitFileLocation, line?: number) {
    const origin = this.inspection?.origin;
    if (this.busy || !origin) return;
    const generation = ++this.generation;
    this.busy = true; this.error = undefined; this.changed();
    try {
      let revision = this.revisions.get(`${location.commit}:${location.path}`);
      if (!revision) {
        const result = await this.data.query({ type: "git.file-revision", origin, location });
        if (generation !== this.generation) return;
        if (!this.data.connected) throw new Error("The original host disconnected. This revision has not been cached.");
        if (result.type !== "git.file-revision" || !sameLocation(result.revision.location, location)) throw new Error("The host returned a different immutable file revision.");
        this.assertOrigin(result.revision.origin); revision = result.revision;
        this.remember(revision);
      }
      this.selected = revision; this.reveal = line === undefined ? undefined : { id: `git-revision-${generation}`, line };
    } catch (error) { if (generation === this.generation) this.error = error instanceof Error ? error.message : "Could not read this immutable revision."; }
    finally { if (generation === this.generation) { this.busy = false; this.changed(); } }
  }
  closeRevision() { this.generation++; this.busy = false; this.selected = undefined; this.reveal = undefined; this.changed(); }
}
