import { BROWSER_AUTOCOMPLETE_PROTOCOL_VERSION, type BrowserAutocompleteMatch, type BrowserAutocompleteOwner,
  type BrowserAutocompleteRequest, type BrowserAutocompleteResult, type BrowserHistoryEntry } from "@agent-desktop/shared";
import { BrowserAutocompleteRecords, browserAutocompleteSourceKey } from "./browser-autocomplete-records";

export interface BrowserAutocompleteHandle {
  workerPid: number;
  workerFailure?: { message: string };
  getBrowserHistory(target: BrowserAutocompleteRequest["target"]): Promise<BrowserHistoryEntry[]>;
}
interface ActiveRequest {
  owner: BrowserAutocompleteOwner;
  generation: string;
  request: Extract<BrowserAutocompleteRequest, { action: "start" }>;
  tokens: Map<string, { kind: "accept" | "delete"; id: string; destinationURL?: string }>;
}
const sameTarget = (a: BrowserAutocompleteRequest["target"], b: BrowserAutocompleteRequest["target"]) =>
  a.workerPid === b.workerPid && a.name === b.name && a.targetId === b.targetId;

export class BrowserAutocompleteService {
  private readonly active = new Map<string, ActiveRequest>();
  constructor(private readonly hostId: string, private readonly records: BrowserAutocompleteRecords) {}

  async execute(owner: BrowserAutocompleteOwner, request: BrowserAutocompleteRequest, handle: BrowserAutocompleteHandle,
    isCurrent: () => boolean | Promise<boolean>): Promise<BrowserAutocompleteResult> {
    const key = JSON.stringify([owner.kind, owner.id, request.target.workerPid, request.target.name, request.target.targetId]);
    const base = (state: BrowserAutocompleteResult["state"], revision = this.records.revision(), matches?: BrowserAutocompleteMatch[]): BrowserAutocompleteResult => ({
      protocolVersion: BROWSER_AUTOCOMPLETE_PROTOCOL_VERSION, hostId: this.hostId, owner: { ...owner }, editingSessionId: request.editingSessionId,
      requestId: request.requestId, target: { ...request.target }, state, revision, ...(matches ? { matches } : {}),
    });
    if (!await isCurrent() || handle.workerFailure || handle.workerPid !== request.target.workerPid) throw new Error("The browser autocomplete owner changed.");
    if (request.action === "start") {
      const generation = crypto.randomUUID(), active: ActiveRequest = { owner: { ...owner }, generation, request, tokens: new Map() };
      if (!this.active.has(key) && this.active.size >= 1_024) throw new Error("This host is handling too many browser autocomplete requests.");
      this.active.set(key, active);
      try {
        const history = await handle.getBrowserHistory(request.target);
        if (!await isCurrent() || handle.workerFailure || this.active.get(key)?.generation !== generation) throw new Error("The browser autocomplete request changed.");
        const observed = history.map(entry => ({ sourceKey: browserAutocompleteSourceKey(owner, request.target, entry.id), entry }));
        this.records.observe(observed);
        const matches = this.records.matches(request.query, (kind, id) => {
          const token = crypto.randomUUID(); active.tokens.set(token, { kind, id }); return token;
        });
        for (const match of matches) if (match.acceptToken) {
          const token = active.tokens.get(match.acceptToken); if (token) token.destinationURL = match.destinationURL;
        }
        if (!await isCurrent() || this.active.get(key)?.generation !== generation) throw new Error("The browser autocomplete request changed.");
        return base("matches", this.records.revision(), matches);
      } catch (cause) {
        if (this.active.get(key)?.generation === generation) this.active.delete(key);
        throw cause;
      }
    }
    const active = this.active.get(key);
    if (!active || active.request.editingSessionId !== request.editingSessionId || active.request.requestId !== request.requestId || !sameTarget(active.request.target, request.target))
      throw new Error("The browser autocomplete request is no longer active.");
    if (request.action === "stop") { this.active.delete(key); return base("stopped"); }
    if (request.action === "accept") {
      const token = active.tokens.get(request.acceptToken);
      if (!token || token.kind !== "accept") throw new Error("The browser suggestion changed.");
      return base("accepted");
    }
    if (request.action === "delete") {
      const token = active.tokens.get(request.deleteToken);
      if (!token || token.kind !== "delete") throw new Error("The browser suggestion changed.");
      const revision = this.records.delete(token.id); this.active.delete(key); return base("deleted", revision);
    }
    const history = await handle.getBrowserHistory(request.target);
    if (!await isCurrent() || handle.workerFailure || this.active.get(key) !== active) throw new Error("The browser autocomplete owner changed during navigation recording.");
    const observed = history.map(entry => ({ sourceKey: browserAutocompleteSourceKey(owner, request.target, entry.id), entry }));
    const revision = this.records.observe(observed, true); this.active.delete(key); return base("recorded", revision);
  }

  /** Records only the history read back from the same native target after a
   * completed host-owned navigation. This does not depend on a renderer
   * autocomplete request having started before the navigation. */
  async observeNavigation(owner: BrowserAutocompleteOwner, target: BrowserAutocompleteRequest["target"], handle: BrowserAutocompleteHandle,
    isCurrent: () => boolean | Promise<boolean>): Promise<string> {
    if (!await isCurrent() || handle.workerFailure || handle.workerPid !== target.workerPid) throw new Error("The browser autocomplete owner changed.");
    const history = await handle.getBrowserHistory(target);
    if (!await isCurrent() || handle.workerFailure || handle.workerPid !== target.workerPid) throw new Error("The browser autocomplete owner changed during navigation recording.");
    const observed = history.map(entry => ({ sourceKey: browserAutocompleteSourceKey(owner, target, entry.id), entry }));
    const revision = this.records.observe(observed, true);
    for (const [key, active] of this.active) if (active.owner.kind === owner.kind && active.owner.id === owner.id && sameTarget(active.request.target, target)) this.active.delete(key);
    return revision;
  }

  retire(owner: BrowserAutocompleteOwner): void {
    for (const [key, active] of this.active) if (active.owner.kind === owner.kind && active.owner.id === owner.id) this.active.delete(key);
  }
}
