import { randomUUID } from "node:crypto";

export interface WindowCloseRequest {
  id: string;
  cancelled?: boolean;
}

type PendingRequest = {
  id: string;
  generation: number;
  promise: Promise<boolean>;
  resolve: (allowed: boolean) => void;
  cancelTimer: () => void;
};

export interface WindowCloseGateOptions {
  send(senderId: number, request: WindowCloseRequest): void;
  unavailable(senderId: number, reason: "renderer-unavailable" | "timeout"): void;
  timeoutMs?: number;
  id?: () => string;
  schedule?: (callback: () => void, delay: number) => () => void;
}

/** Correlates renderer preparation with one window and one close attempt. */
export class WindowCloseGate {
  private readonly ready = new Set<number>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly generations = new Map<number, number>();
  private readonly closing = new Set<number>();
  private readonly closePermits = new Set<number>();
  private quitAttempt: Promise<void> | undefined;
  private quitPermit = false;

  constructor(private readonly options: WindowCloseGateOptions) {}

  register(senderId: number): void {
    this.ready.add(senderId);
  }

  unregister(senderId: number, notify = true): void {
    const wasReady = this.ready.delete(senderId);
    this.generations.set(senderId, (this.generations.get(senderId) ?? 0) + 1);
    if (this.cancel(senderId, notify && wasReady)) this.options.unavailable(senderId, "renderer-unavailable");
  }

  destroy(senderId: number): void {
    this.ready.delete(senderId);
    this.generations.set(senderId, (this.generations.get(senderId) ?? 0) + 1);
    this.cancel(senderId, false);
    this.closing.delete(senderId);
    this.closePermits.delete(senderId);
  }

  request(senderId: number): Promise<boolean> {
    return this.beginRequest(senderId).promise;
  }

  private beginRequest(senderId: number): {id?: string; generation: number; promise: Promise<boolean>} {
    const current = this.pending.get(senderId);
    if (current) return { id: current.id, generation: current.generation, promise: current.promise };
    const generation = this.generations.get(senderId) ?? 0;
    if (!this.ready.has(senderId)) {
      this.options.unavailable(senderId, "renderer-unavailable");
      return { generation, promise: Promise.resolve(false) };
    }

    const id = (this.options.id ?? randomUUID)();
    let resolve!: (allowed: boolean) => void;
    const promise = new Promise<boolean>(settle => { resolve = settle; });
    const schedule = this.options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
    const pending: PendingRequest = { id, generation, promise, resolve, cancelTimer: () => {} };
    this.pending.set(senderId, pending);
    pending.cancelTimer = schedule(() => {
      if (this.pending.get(senderId) !== pending) return;
      try { this.options.send(senderId, { id, cancelled: true }); }
      catch { /* Reporting below is sufficient when the renderer vanished. */ }
      this.settle(senderId, pending, false);
      this.options.unavailable(senderId, "timeout");
    }, this.options.timeoutMs ?? 15_000);
    try {
      this.options.send(senderId, { id });
    } catch {
      this.settle(senderId, pending, false);
      this.options.unavailable(senderId, "renderer-unavailable");
    }
    return { id, generation, promise };
  }

  answer(senderId: number, id: string, allowed: boolean): boolean {
    const pending = this.pending.get(senderId);
    if (!pending || pending.id !== id) return false;
    this.settle(senderId, pending, allowed);
    return true;
  }

  /** Returns true only for the single close re-entered after preparation. */
  handleWindowClose(senderId: number, close: () => void): boolean {
    if (this.closePermits.delete(senderId)) return true;
    if (this.closing.has(senderId)) return false;
    this.closing.add(senderId);
    const request = this.beginRequest(senderId);
    void request.promise.then(allowed => {
      if (allowed && this.isCurrent(senderId, request.generation)) {
        this.closePermits.add(senderId);
        close();
      } else if (allowed) {
        this.cancelApproved(senderId, request.id);
        this.options.unavailable(senderId, "renderer-unavailable");
      }
    }).finally(() => this.closing.delete(senderId));
    return false;
  }

  /** Returns true only for the app.quit call re-entered after every window approves. */
  consumeQuitPermit(): boolean {
    if (!this.quitPermit) return false;
    this.quitPermit = false;
    return true;
  }

  requestQuit(senderIds: number[], quit: () => void): void {
    if (this.quitAttempt) return;
    const ids = [...new Set(senderIds)];
    const requests = ids.map(senderId => {
      const request = this.beginRequest(senderId);
      return request.promise.then(allowed => ({ senderId, id: request.id, generation: request.generation, allowed }));
    });
    this.quitAttempt = Promise.all(requests).then(results => {
      if (results.every(result => result.allowed && this.isCurrent(result.senderId, result.generation))) {
        for (const senderId of ids) this.closePermits.add(senderId);
        this.quitPermit = true;
        quit();
      } else {
        // A renderer that already approved stays in its prepared/inert state
        // until main explicitly tells it that the collective quit was canceled.
        for (const result of results) if (result.allowed) this.cancelApproved(result.senderId, result.id);
        for (const result of results) if (result.allowed && !this.isCurrent(result.senderId, result.generation)) {
          this.options.unavailable(result.senderId, "renderer-unavailable");
        }
      }
    }).finally(() => { this.quitAttempt = undefined; });
  }

  private cancel(senderId: number, notify: boolean): boolean {
    const pending = this.pending.get(senderId);
    if (!pending) return false;
    if (notify) {
      try { this.options.send(senderId, { id: pending.id, cancelled: true }); }
      catch { /* The renderer is already unavailable. */ }
    }
    this.settle(senderId, pending, false);
    return true;
  }

  private settle(senderId: number, pending: PendingRequest, allowed: boolean): void {
    if (this.pending.get(senderId) !== pending) return;
    this.pending.delete(senderId);
    pending.cancelTimer();
    pending.resolve(allowed);
  }

  private isCurrent(senderId: number, generation: number): boolean {
    return this.ready.has(senderId) && (this.generations.get(senderId) ?? 0) === generation;
  }

  private cancelApproved(senderId: number, id: string | undefined): void {
    if (!id || !this.ready.has(senderId)) return;
    try { this.options.send(senderId, { id, cancelled: true }); }
    catch { /* A window independently closed while the quit was pending. */ }
  }
}
