import { validBrowserFrameTarget, type BrowserFrameTarget } from "@agent-desktop/shared";

export interface WorkerBrowserCloseResult extends BrowserFrameTarget {
  ownerId: string;
  released: true;
}
interface Owner { readonly id: string }
interface CloseApi {
  BROWSER_TAB_OWNER_CLOSE_VERSION?: number;
  releaseTabForOwner?: (ownerId: string, target: { name: string; targetId: string }) => Promise<unknown>;
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
function rejected(message: string): Error { const error = new Error(message); error.name = "BrowserActionRejected"; return error; }
function unknown(message: string): Error & { code: "OUTCOME_UNKNOWN" } {
  return Object.assign(new Error(message), { code: "OUTCOME_UNKNOWN" as const });
}
function targetForWorker(value: unknown, pid: number): BrowserFrameTarget {
  if (!validBrowserFrameTarget(value) || value.workerPid !== pid) throw rejected("The browser close target belongs to a stale or invalid worker.");
  return { workerPid: value.workerPid, name: value.name, targetId: value.targetId };
}

/** Retains native close work through child retirement, including the deferred SDK import. */
export class WorkerBrowserCloses {
  #pending = new Set<{ promise: Promise<WorkerBrowserCloseResult>; dispatched: boolean }>();
  #closing: Promise<void> | undefined;
  constructor(readonly pid: number, readonly readOwner: () => Owner,
    readonly load: () => Promise<CloseApi> = async () => await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") as CloseApi) {}

  close(value: BrowserFrameTarget): Promise<WorkerBrowserCloseResult> {
    if (this.#closing) return Promise.reject(rejected("The browser worker is stopping."));
    let target: BrowserFrameTarget, owner: Owner, ownerId: string;
    try {
      target = targetForWorker(value, this.pid); owner = this.readOwner(); ownerId = owner.id;
      if (!identity(ownerId)) throw rejected("The browser worker has no valid owner.");
    } catch (error) { return Promise.reject(error); }
    // Register before calling external code, so reentrant retirement sees this operation.
    const completion = Promise.withResolvers<WorkerBrowserCloseResult>();
    const task = { promise: completion.promise, dispatched: false };
    this.#pending.add(task);
    void (async () => {
      const native = await this.load();
      if (this.#closing || this.readOwner() !== owner || owner.id !== ownerId) throw rejected("The browser owner changed before close admission.");
      if (native.BROWSER_TAB_OWNER_CLOSE_VERSION !== 1 || typeof native.releaseTabForOwner !== "function") {
        throw rejected("This host's pinned native browser does not support confirmed owner-bound close.");
      }
      task.dispatched = true;
      const result = await native.releaseTabForOwner(ownerId, { name: target.name, targetId: target.targetId });
      if (!result || typeof result !== "object") throw unknown("Native browser close returned no confirmation.");
      const receipt = result as Record<string, unknown>;
      if (receipt.ownerSessionId !== ownerId || receipt.name !== target.name || receipt.targetId !== target.targetId || receipt.released !== true) {
        throw unknown("Native browser close returned a different target or an unconfirmed result.");
      }
      return { ...target, ownerId, released: true as const };
    })().then(completion.resolve, completion.reject);
    void task.promise.then(() => this.#pending.delete(task), () => this.#pending.delete(task));
    return task.promise;
  }

  dispose(): Promise<void> {
    if (this.#closing) return this.#closing;
    const completion = Promise.withResolvers<void>(); this.#closing = completion.promise;
    const tasks = [...this.#pending];
    void Promise.allSettled(tasks.map(task => task.promise)).then(results => {
      const errors = results.flatMap((result, index) => result.status === "rejected" && tasks[index]!.dispatched ? [result.reason] : []);
      if (errors.length) completion.reject(new AggregateError(errors, "Native browser close cleanup failed."));
      else completion.resolve();
    });
    return completion.promise;
  }
}

/** The daemon never loads the native module; it validates the child's exact confirmation. */
export async function requestWorkerBrowserClose(client: {
  pid: number;
  request(operation: { operation: "closeBrowserTab"; args: { target: BrowserFrameTarget } }): Promise<unknown>;
}, ownerId: string, value: BrowserFrameTarget): Promise<WorkerBrowserCloseResult> {
  const target = targetForWorker(value, client.pid);
  if (!identity(ownerId)) throw rejected("The browser worker has no valid owner.");
  const result = await client.request({ operation: "closeBrowserTab", args: { target: { ...target } } });
  if (!result || typeof result !== "object") throw unknown("The browser worker returned no close confirmation.");
  const receipt = result as Partial<WorkerBrowserCloseResult>;
  if (receipt.ownerId !== ownerId || receipt.workerPid !== target.workerPid || receipt.name !== target.name || receipt.targetId !== target.targetId || receipt.released !== true) {
    throw unknown("The browser worker returned a stale or unconfirmed close result.");
  }
  return { ...target, ownerId, released: true };
}
