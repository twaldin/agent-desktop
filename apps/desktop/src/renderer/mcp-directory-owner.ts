import { parseMcpOwnerResult, type McpOwnerBridge, type McpOwnerRequest, type McpOwnerSnapshot, type NativeMcpAppRequest, type NativeMcpAppResponse, type OmpInteractionResponse } from "@agent-desktop/shared";

interface AcquisitionAttempt { request: Extract<McpOwnerRequest, { type: "acquire" }>; retired: boolean; opening: Promise<McpOwnerSnapshot>; closing?: Promise<void>; notified?: boolean }

/** A view acquires one native directory context deliberately. A lost connection
 * retires that attempt; restored app descriptors never revive its worker. */
export class McpDirectoryOwner {
  #listeners = new Set<() => void>();
  #retireListeners = new Set<() => void>();
  subscribeClose(listener: () => void): () => void { this.#retireListeners.add(listener); return () => { this.#retireListeners.delete(listener); }; }
  #attempt?: AcquisitionAttempt;
  #channels = new Map<string, AcquisitionAttempt>();
  #connected = false;
  #disposed = false;
  #reading?: Promise<void>;
  snapshot?: McpOwnerSnapshot;
  error?: string;
  loading = false;
  responding = new Set<string>();
  constructor(readonly bridge: McpOwnerBridge, readonly hostId: string, readonly projectId: string | null) {}
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #changed() { for (const listener of this.#listeners) listener(); }
  connected(value: boolean) { if (this.#connected === value) return; this.#connected = value; if (!value && this.#attempt) { void this.#close(this.#attempt).catch(error => this.#fail(error)); this.snapshot = undefined; this.#changed(); } }
  #fail(error: unknown) { this.error = error instanceof Error ? error.message : "The original MCP operation could not be confirmed."; this.#changed(); }
  current(): boolean { return this.#connected && !this.#disposed && !!this.snapshot && this.#attempt?.retired === false; }
  isCurrentSnapshot(snapshot: McpOwnerSnapshot): boolean {
    return this.current() && this.snapshot?.ownerId === snapshot.ownerId && this.snapshot.epoch === snapshot.epoch
      && this.snapshot.catalogue.epoch === snapshot.catalogue.epoch && this.snapshot.catalogue.revision === snapshot.catalogue.revision;
  }
  acquire(expectedDirectory?: string): Promise<McpOwnerSnapshot> {
    if (!this.#connected || this.#disposed) return Promise.reject(new Error("Connect to the original MCP host first."));
    const previous = this.#attempt;
    if (previous && !previous.retired) return previous.opening.then(snapshot => {
      if (expectedDirectory !== undefined && snapshot.cwd !== expectedDirectory) throw new Error("The saved app directory changed.");
      return snapshot;
    });
    const attempt = { request: { type: "acquire" as const, ownerId: crypto.randomUUID(), target: { projectId: this.projectId, ...(expectedDirectory ? { expectedDirectory } : {}) } }, retired: false } as AcquisitionAttempt;
    this.#attempt = attempt; this.loading = true; this.error = undefined;
    attempt.opening = Promise.resolve().then(async () => {
      if (previous) await this.#close(previous);
      this.#assertCurrent(attempt);
      const value = parseMcpOwnerResult(await this.bridge.request(this.hostId, attempt.request), attempt.request);
      this.#assertCurrent(attempt);
      if (!("catalogue" in value)) throw new Error("Invalid MCP discovery response.");
      this.snapshot = value; this.#changed(); return value;
    });
    void attempt.opening.catch(error => { attempt.retired = true; this.#fail(error); void this.#close(attempt).catch(error => this.#fail(error)); }).finally(() => { if (this.#attempt === attempt) { this.loading = false; this.#changed(); } });
    this.#changed(); return attempt.opening;
  }
  #assertCurrent(attempt: AcquisitionAttempt) {
    if (this.#disposed || !this.#connected || this.#attempt !== attempt || attempt.retired) throw new Error("The original MCP directory connection ended. Connect again deliberately.");
  }
  async catalogue(expectedDirectory: string, signal: AbortSignal) {
    const snapshot = await this.acquire(expectedDirectory), attempt = this.#attempt!;
    const deadline = Date.now() + 90_000;
    while (!this.snapshot?.catalogue.available) {
      this.#assertCurrent(attempt); signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Native app discovery is still pending. Check App connections before retrying.");
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 100);
        signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
      });
    }
    this.#assertCurrent(attempt); signal.throwIfAborted();
    if (this.snapshot.ownerId !== snapshot.ownerId || this.snapshot.cwd !== expectedDirectory) throw new Error("The original MCP directory changed.");
    return this.snapshot.catalogue;
  }
  async request(request: NativeMcpAppRequest): Promise<NativeMcpAppResponse> {
    let attempt = this.#channels.get(request.channelId);
    if (request.type === "open" && !attempt) {
      attempt = this.#attempt;
      if (!attempt) throw new Error("Connect to this app’s original directory first.");
      this.#assertCurrent(attempt);
      if (this.#channels.size >= 4096) throw new Error("MCP app channel limit exceeded.");
      this.#channels.set(request.channelId, attempt);
    }
    if (!attempt) {
      if (request.type === "close") return { type: "closed", channelId: request.channelId };
      throw new Error("The original MCP app channel is unavailable.");
    }
    if (request.type === "close" && attempt.retired) {
      await this.#close(attempt);
      return { type: "closed", channelId: request.channelId };
    }
    const snapshot = await attempt.opening;
    if (request.type !== "close") this.#assertCurrent(attempt);
    const input = { type: "app" as const, ownerId: snapshot.ownerId, epoch: snapshot.epoch, request };
    const result = parseMcpOwnerResult(await this.bridge.request(this.hostId, input), input);
    if (request.type !== "close") this.#assertCurrent(attempt);
    if (!("type" in result)) throw new Error("Invalid MCP app response.");
    return result;
  }
  refresh(): Promise<void> {
    if (this.#reading) return this.#reading;
    const attempt = this.#attempt;
    if (!attempt || !this.current()) return Promise.resolve();
    this.#reading = (async () => {
      const original = await attempt.opening; this.#assertCurrent(attempt);
      const request = { type: "read" as const, ownerId: original.ownerId, epoch: original.epoch };
      const value = parseMcpOwnerResult(await this.bridge.request(this.hostId, request), request); this.#assertCurrent(attempt);
      if (!("catalogue" in value) || value.cwd !== original.cwd || value.projectId !== original.projectId) throw new Error("The original MCP directory changed.");
      this.snapshot = value; this.error = undefined; this.#changed();
    })().catch(error => { if (this.#attempt === attempt && !attempt.retired) { attempt.retired = true; this.snapshot = undefined; this.#fail(error); void this.#close(attempt).catch(error => this.#fail(error)); } }).finally(() => { this.#reading = undefined; });
    return this.#reading;
  }
  async respond(id: string, response: OmpInteractionResponse): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt || this.responding.has(id)) return;
    this.responding.add(id); this.#changed();
    try {
      const snapshot = await attempt.opening; this.#assertCurrent(attempt);
      if (!this.snapshot?.interactions.some(value => value.id === id)) throw new Error("The original permission request ended.");
      const request = { type: "answer" as const, ownerId: snapshot.ownerId, epoch: snapshot.epoch, interactionId: id, response };
      const value = parseMcpOwnerResult(await this.bridge.request(this.hostId, request), request); this.#assertCurrent(attempt);
      if (!("catalogue" in value) || value.cwd !== snapshot.cwd || value.projectId !== snapshot.projectId) throw new Error("Invalid MCP permission response.");
      this.snapshot = value; this.error = undefined;
    } catch (error) { this.#fail(error); }
    finally { this.responding.delete(id); this.#changed(); }
  }
  #close(attempt: AcquisitionAttempt): Promise<void> {
    if (attempt.closing) return attempt.closing;
    attempt.retired = true;
    attempt.closing = Promise.resolve().then(async () => {
      await attempt.opening.catch(() => {});
      const request = { ...attempt.request, type: "retire" as const };
      parseMcpOwnerResult(await this.bridge.request(this.hostId, request), request);
    });
    if (!attempt.notified) { attempt.notified = true; for (const listener of this.#retireListeners) listener(); }
    void attempt.closing.catch(() => { attempt.closing = undefined; });
    return attempt.closing;
  }
  disconnect(): Promise<void> { this.snapshot = undefined; this.#changed(); return this.#attempt ? this.#close(this.#attempt).catch(error => { this.#fail(error); throw error; }) : Promise.resolve(); }
  dispose(): Promise<void> { this.#disposed = true; this.snapshot = undefined; return this.#attempt ? this.#close(this.#attempt) : Promise.resolve(); }
}
