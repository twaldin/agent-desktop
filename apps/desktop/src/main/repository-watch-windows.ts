import { parseRepositoryWatchRequest, type RepositoryWatchObserverStatus, type RepositoryWatchRequest, type RepositoryWatchView } from "@agent-desktop/shared";
import type { RepositoryWatchConnection } from "./repository-watch-connection";

interface Entry {
  request: RepositoryWatchRequest;
  view: RepositoryWatchView;
  isCurrent(): boolean;
  released: boolean;
  pending?: Promise<void>;
  lease?: ReturnType<RepositoryWatchConnection["retain"]>;
}
interface WindowOwner { token: string; entries: Map<string, Entry> }

/** A renderer lifetime owns admission, even while host endpoint lookup is unresolved. */
export class RepositoryWatchWindows {
  #windows = new Map<number, WindowOwner>();
  #disposed = false;
  constructor(private options: {
    connect(hostId: string, isCurrent: () => boolean): Promise<RepositoryWatchConnection>;
    notify(senderId: number, status: RepositoryWatchObserverStatus): void;
  }) {}

  reset(senderId: number): void {
    if (this.#disposed) return;
    this.releaseWindow(senderId);
    this.#windows.set(senderId, { token: crypto.randomUUID(), entries: new Map() });
  }
  token(senderId: number): string | undefined { return this.#windows.get(senderId)?.token; }
  #current(senderId: number, owner: WindowOwner, entry: Entry): boolean {
    if (this.#disposed || this.#windows.get(senderId) !== owner || entry.released) return false;
    if (entry.isCurrent()) return true;
    this.#release(entry); return false;
  }
  #publish(senderId: number, owner: WindowOwner, entry: Entry): void {
    if (this.#disposed || this.#windows.get(senderId) !== owner) return;
    if (!entry.isCurrent()) { this.#release(entry); return; }
    try { this.options.notify(senderId, { hostId: entry.request.hostId, subscriptionId: entry.request.subscriptionId, target: { ...entry.request.target }, view: { ...entry.view } }); }
    catch (error) { console.error("Repository watch window delivery failed:", error); this.releaseWindow(senderId); }
  }
  dispatch(senderId: number, value: unknown, isCurrent: () => boolean, token: unknown): Promise<void> {
    const owner = this.#windows.get(senderId);
    if (this.#disposed || !owner || token !== owner.token || !isCurrent()) throw new Error("The repository watch window is unavailable.");
    const request = parseRepositoryWatchRequest(value);
    let entry = owner.entries.get(request.subscriptionId);
    if (entry && (entry.request.hostId !== request.hostId || JSON.stringify(entry.request.target) !== JSON.stringify(request.target))) {
      throw new Error("The repository watch observer belongs to a different owner.");
    }
    if (!entry) {
      entry = { request, view: { phase: "unavailable" }, isCurrent, released: false };
      if (request.action === "inspect") { this.#publish(senderId, owner, entry); return Promise.resolve(); }
      if (owner.entries.size >= 2048) throw new Error("The repository watch window history is full. Reopen this window to continue.");
      owner.entries.set(request.subscriptionId, entry);
      if (request.action === "retain") {
        const active = [...owner.entries.values()].filter(item => !item.released && (item.lease !== undefined || ["connecting", "pending", "ready", "disconnected", "unsupported"].includes(item.view.phase))).length;
        if (active >= 128) entry.view = { phase: "failed", error: "Too many repository watches in this window." };
        else this.#start(senderId, owner, entry);
      }
    }
    if (request.action === "release") this.#release(entry);
    else if (request.action === "inspect" && this.#current(senderId, owner, entry)) entry.lease?.inspect();
    this.#publish(senderId, owner, entry);
    return request.action === "retain" ? entry.pending ?? Promise.resolve() : Promise.resolve();
  }
  #start(senderId: number, owner: WindowOwner, entry: Entry): void {
    entry.view = { phase: "connecting" };
    const current = () => this.#current(senderId, owner, entry);
    entry.pending = Promise.resolve().then(async () => {
      if (!current()) return;
      const connection = await this.options.connect(entry.request.hostId, current);
      if (!current()) return;
      const lease = connection.retain(entry.request.target, view => {
        if (!current()) return;
        entry.view = view; this.#publish(senderId, owner, entry);
      });
      if (current()) entry.lease = lease;
      else lease.dispose();
    }).catch(error => {
      if (!current()) return;
      entry.view = { phase: "failed", error: error instanceof Error ? error.message : String(error) };
      this.#publish(senderId, owner, entry);
    });
  }
  #release(entry: Entry): void {
    if (entry.released) return;
    entry.released = true; entry.view = { phase: "released" };
    entry.lease?.dispose(); entry.lease = undefined;
  }
  releaseWindow(senderId: number): void {
    const owner = this.#windows.get(senderId);
    this.#windows.delete(senderId);
    if (owner) for (const entry of owner.entries.values()) this.#release(entry);
  }
  dispose(): void {
    this.#disposed = true;
    for (const id of [...this.#windows.keys()]) this.releaseWindow(id);
  }
}
