import { symbolLanguage, symbolOffset, type SymbolBuffer, type SymbolDefinition, type SymbolLocation, type SymbolPosition, type SymbolSelection } from "../../../../packages/shared/src/symbol-navigation";
import { workspaceKey, type WorkspaceState } from "./workspace-state";

export interface SymbolEditorSnapshot { text: string; selections: SymbolSelection[]; position?: SymbolPosition }
export interface SymbolRevealRequest { id: string; path: string; line: number; column: number; selections: SymbolSelection[]; text: string }
export interface SymbolEditorNavigation { navigation: SymbolNavigation; path: string; open(location: SymbolLocation): void }
interface Choice { origin: SymbolLocation; sourceText: string; buffers: SymbolBuffer[]; definitions: SymbolDefinition[] }
interface Pending { request: SymbolRevealRequest; origin: SymbolLocation; destination: SymbolLocation; index?: number; timeout: ReturnType<typeof setTimeout> }
const navigations = new WeakMap<WorkspaceState, SymbolNavigation>();
export function workspaceSymbolNavigation(data: WorkspaceState): SymbolNavigation {
  let navigation = navigations.get(data);
  if (!navigation) { navigation = new SymbolNavigation(data); navigations.set(data, navigation); }
  return navigation;
}
export async function symbolTextHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function sameLocation(a: SymbolLocation | undefined, b: SymbolLocation): boolean {
  return a?.hostId === b.hostId && workspaceKey(a.target) === workspaceKey(b.target) && a.workspaceIdentity === b.workspaceIdentity && a.path === b.path && a.textHash === b.textHash && JSON.stringify(a.selections) === JSON.stringify(b.selections);
}

/** Per-window, per-owner location history, not Pierre's edit undo timeline. */
export class SymbolNavigation {
  entries: SymbolLocation[] = [];
  index = -1;
  busy = false;
  message = "";
  choice?: Choice;
  pending?: Pending;
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(readonly data: WorkspaceState) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  get canBack() { return !this.busy && this.index > 0; }
  get canForward() { return !this.busy && this.index >= 0 && this.index < this.entries.length - 1; }
  unavailable(path: string): string | undefined {
    const document = this.data.documents.get(path);
    if (!this.data.connected) return "Reconnect to the owning host to resolve or revisit symbols.";
    if (this.data.standalonePath) return "Open this file in its project workspace to navigate definitions.";
    if (!symbolLanguage(path)) return "Definitions support JavaScript, JSX, TypeScript and TSX only.";
    if (!this.data.restored || document?.content?.kind !== "text") return "Load or save this source file before navigating definitions.";
    if (document.conflict !== undefined) return "Resolve the host file conflict before navigating definitions. Your edits are retained.";
    if (this.data.busy || this.data.pending) return "Wait for the pending workspace change before navigating definitions.";
  }
  cancel() {
    this.generation++; clearTimeout(this.pending?.timeout); this.pending = undefined;
    this.choice = undefined; this.busy = false; this.message = ""; this.changed();
  }
  private async capture(path: string, snapshot: SymbolEditorSnapshot): Promise<SymbolLocation> {
    const document = this.data.documents.get(path);
    if (!document || document.content?.kind !== "text" || document.conflict !== undefined || snapshot.text !== document.text || !snapshot.selections.length)
      throw new Error("The editor changed or has no cursor. Select the symbol again; your buffer is retained.");
    const revision = document.content.revision, context = await this.data.query({ type: "file.symbol-context" });
    if (context.type !== "file.symbol-context") throw new Error("The host did not identify this symbol workspace.");
    const textHash = await symbolTextHash(snapshot.text);
    const current = this.data.documents.get(path);
    if (current?.text !== snapshot.text || current.content?.revision !== revision || current.conflict !== undefined) throw new Error("The document changed while capturing its location. Retry.");
    for (const selection of snapshot.selections) { symbolOffset(snapshot.text, selection.start); symbolOffset(snapshot.text, selection.end); }
    return { path, revision, textHash, name: "", selection: structuredClone(snapshot.selections[0]!), selections: structuredClone(snapshot.selections), hostId: this.data.hostId, target: { ...this.data.target }, workspaceIdentity: context.workspaceIdentity };
  }
  private buffers(): SymbolBuffer[] {
    const buffers: SymbolBuffer[] = [];
    for (const [path, item] of this.data.documents) {
      if (!item.dirty) continue;
      if (path.toLowerCase().endsWith(".json")) throw new Error(`Save or resolve ${path} before looking up symbols; unsaved JSON project configuration is not used by the compiler.`);
      if (!symbolLanguage(path)) continue;
      if (item.content?.kind !== "text" || item.conflict !== undefined) throw new Error(`Save or resolve ${path} before resolving symbols across unsaved buffers.`);
      buffers.push({ path, revision: item.content.revision, text: item.text });
    }
    return buffers;
  }
  private choiceCurrent(choice: Choice): boolean {
    const source = this.data.documents.get(choice.origin.path);
    if (!this.data.connected || source?.text !== choice.sourceText || source.content?.revision !== choice.origin.revision || source.conflict !== undefined) return false;
    const buffers = this.buffers();
    return buffers.length === choice.buffers.length && buffers.every((buffer, index) => {
      const prior = choice.buffers[index]!;
      return buffer.path === prior.path && buffer.revision === prior.revision && buffer.text === prior.text;
    });
  }
  async define(path: string, snapshot: SymbolEditorSnapshot | undefined, open: SymbolEditorNavigation["open"]) {
    if (this.busy) return;
    this.message = ""; this.choice = undefined;
    const unavailable = this.unavailable(path);
    if (unavailable || !snapshot) { this.message = unavailable ?? "Focus the source editor and select a symbol first."; this.changed(); return; }
    const generation = ++this.generation; this.busy = true; this.changed();
    try {
      const origin = await this.capture(path, snapshot), buffers = this.buffers();
      const selection = origin.selections[0]!, position = snapshot.position ?? (selection.direction === "backward" ? selection.start : selection.end);
      const result = await this.data.query({ type: "file.definitions", request: { path, revision: origin.revision, position, buffers, source: "working-tree" } });
      if (generation !== this.generation) return;
      if (result.type !== "file.definitions") throw new Error("The host did not return semantic definitions.");
      if (result.workspaceIdentity !== origin.workspaceIdentity) throw new Error("The owning workspace changed during lookup. Reopen the file before retrying.");
      const choice = { origin, sourceText: snapshot.text, buffers, definitions: result.result.status === "definitions" ? result.result.definitions : [] };
      if (!this.choiceCurrent(choice)) throw new Error("The source or an unsaved dependency changed during lookup. Select the symbol again.");
      if (result.result.status !== "definitions") { this.message = result.result.message; return; }
      if (!choice.definitions.length) throw new Error("The provider returned an empty definition result. Retry the lookup.");
      this.choice = choice;
      if (choice.definitions.length === 1) await this.choose(0, open, generation);
      else this.message = `${choice.definitions.length} definitions. Choose a location.`;
    } catch (error) { if (generation === this.generation) this.message = error instanceof Error ? error.message : String(error); }
    finally { if (generation === this.generation && !this.pending) { this.busy = false; this.changed(); } }
  }
  async choose(index: number, open: SymbolEditorNavigation["open"], generation = ++this.generation) {
    const choice = this.choice, definition = choice?.definitions[index];
    if (!choice || !definition || this.pending) return;
    this.busy = true; this.changed();
    try {
      if (!this.choiceCurrent(choice)) throw new Error("These definitions belong to an older source snapshot. Dismiss and run Go to definition again.");
      const destination: SymbolLocation = { ...definition, hostId: choice.origin.hostId, target: { ...choice.origin.target }, workspaceIdentity: choice.origin.workspaceIdentity, selections: [definition.selection] };
      await this.navigate(choice.origin, destination, open, generation);
    } catch (error) { if (generation === this.generation) this.message = error instanceof Error ? error.message : String(error); }
    finally { if (generation === this.generation && !this.pending) { this.busy = false; this.changed(); } }
  }
  async travel(direction: -1 | 1, path: string, snapshot: SymbolEditorSnapshot | undefined, open: SymbolEditorNavigation["open"]) {
    if (this.busy || !snapshot) return;
    const index = this.index + direction, destination = this.entries[index];
    if (!destination) return;
    const generation = ++this.generation; this.busy = true; this.message = ""; this.choice = undefined; this.changed();
    try {
      if (!this.data.connected) throw new Error("Reconnect before revisiting a symbol location; cached files may have changed.");
      const origin = await this.capture(path, snapshot);
      await this.navigate(origin, destination, open, generation, index);
    } catch (error) { if (generation === this.generation) this.message = error instanceof Error ? error.message : String(error); }
    finally { if (generation === this.generation && !this.pending) { this.busy = false; this.changed(); } }
  }
  private async navigate(origin: SymbolLocation, destination: SymbolLocation, open: SymbolEditorNavigation["open"], generation: number, index?: number) {
    if (destination.hostId !== this.data.hostId || workspaceKey(destination.target) !== workspaceKey(this.data.target)) throw new Error("This symbol location belongs to another host or workspace. Reopen its original owner.");
    if (!this.data.connected || this.data.busy || this.data.pending) throw new Error("Reconnect and wait for pending workspace changes before navigating.");
    const context = await this.data.query({ type: "file.symbol-context" });
    if (context.type !== "file.symbol-context" || context.workspaceIdentity !== destination.workspaceIdentity || context.workspaceIdentity !== origin.workspaceIdentity)
      throw new Error("This location belongs to a replaced or moved workspace. Reopen its original repository; history has not moved.");
    // WorkspaceState.read protects dirty buffers; do not replace/save/discard them here.
    await this.data.read(destination.path);
    if (generation !== this.generation) return;
    const item = this.data.documents.get(destination.path);
    if (this.data.errors[`file:${destination.path}`]) throw new Error(`Cannot open ${destination.path}: ${this.data.errors[`file:${destination.path}`]}. Restore the file or choose another location.`);
    if (!item || item.content?.kind !== "text" || item.conflict !== undefined) throw new Error("The target is missing, unreadable or conflicted. Resolve it before revisiting this location. Unsaved buffers are retained.");
    const text = item.text;
    if (item.content.revision !== destination.revision || await symbolTextHash(text) !== destination.textHash
      || this.data.documents.get(destination.path)?.text !== text || this.data.documents.get(destination.path)?.content?.revision !== destination.revision
      || this.data.documents.get(destination.path)?.conflict !== undefined)
      throw new Error("The destination changed since this location was recorded. Go to definition again from the current source; history has not moved.");
    const source = this.data.documents.get(origin.path), sourceText = source?.text;
    if (!source || sourceText === undefined || source.content?.revision !== origin.revision || await symbolTextHash(sourceText) !== origin.textHash
      || this.data.documents.get(origin.path)?.text !== sourceText || this.data.documents.get(origin.path)?.content?.revision !== origin.revision
      || this.data.documents.get(origin.path)?.conflict !== undefined)
      throw new Error("The origin changed before navigation. Select the symbol again.");
    if (generation !== this.generation || !this.data.connected) return;
    const first = destination.selections[0]!;
    for (const selection of destination.selections) { symbolOffset(text, selection.start); symbolOffset(text, selection.end); }
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => this.revealed(id, "The file opener did not reveal this location. Retry from the source editor."), 10_000);
    this.pending = { origin, destination, index, timeout, request: { id, path: destination.path, text, selections: structuredClone(destination.selections), line: first.start.line, column: first.start.column } };
    this.choice = undefined; this.message = "Opening symbol location…"; this.changed();
    try { open(destination); } catch (error) { this.revealed(id, error instanceof Error ? error.message : String(error)); }
  }
  revealed(id: string, error?: string) {
    const pending = this.pending;
    if (!pending || pending.request.id !== id) return;
    clearTimeout(pending.timeout); this.pending = undefined; this.busy = false;
    if (error) { this.message = error; this.changed(); return; }
    if (pending.index !== undefined) {
      if (this.index >= 0 && this.entries[this.index]?.path === pending.origin.path) this.entries[this.index] = pending.origin;
      this.index = pending.index;
    } else {
      const entries = this.entries.slice(0, this.index + 1);
      if (!sameLocation(entries.at(-1), pending.origin)) entries.push(pending.origin);
      if (!sameLocation(entries.at(-1), pending.destination)) entries.push(pending.destination);
      this.entries = entries.slice(-100); this.index = this.entries.length - 1;
    }
    this.message = ""; this.changed();
  }
}
