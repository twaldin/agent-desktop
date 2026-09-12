import { validBrowserFrameTarget, type BrowserFrameTarget } from "@agent-desktop/shared";

export interface WorkerBrowserObservation extends BrowserFrameTarget {
  ownerId: string;
  kindTag: "headless" | "spawned" | "connected" | "relay" | "cmux";
  presence: "present" | "absent";
}
interface Owner { readonly id: string }
interface ObservationApi {
  inspectTabForOwner?: (ownerId: string, target: { name: string; targetId: string }) => Promise<unknown>;
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
function targetForWorker(value: unknown, pid: number): BrowserFrameTarget {
  if (!validBrowserFrameTarget(value) || value.workerPid !== pid) throw new Error("The browser observation target belongs to a stale or invalid worker.");
  return { workerPid: value.workerPid, name: value.name, targetId: value.targetId };
}
function projection(value: unknown, target: BrowserFrameTarget, ownerId: string, native: boolean): WorkerBrowserObservation {
  if (!value || typeof value !== "object") throw new Error("Browser observation returned no original-owner result.");
  const result = value as Record<string, unknown>;
  if (result[native ? "ownerSessionId" : "ownerId"] !== ownerId || result.name !== target.name || result.targetId !== target.targetId
    || !native && result.workerPid !== target.workerPid
    || !["headless", "spawned", "connected", "relay", "cmux"].includes(result.kindTag as string)
    || result.presence !== "present" && result.presence !== "absent"
    || result.kindTag === "cmux" && result.presence === "absent") {
    throw new Error("Browser observation returned a stale, invalid or unsupported presence result.");
  }
  return { ...target, ownerId, kindTag: result.kindTag as WorkerBrowserObservation["kindTag"], presence: result.presence };
}

/** Validate a worker reply without importing the native implementation. */
export function parseWorkerBrowserObservation(value: unknown, target: BrowserFrameTarget, ownerId: string): WorkerBrowserObservation {
  return projection(value, target, ownerId, false);
}

/** Read-only original-owner lookup. Retirement waits for admitted native work. */
export class WorkerBrowserObservations {
  #pending = new Map<string, { promise: Promise<WorkerBrowserObservation>; failure?: { error: unknown } }>();
  #closing: Promise<void> | undefined;
  constructor(readonly pid: number, readonly readOwner: () => Owner,
    readonly load: () => Promise<ObservationApi> = async () => await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") as ObservationApi) {}

  inspect(value: BrowserFrameTarget): Promise<WorkerBrowserObservation> {
    if (this.#closing) return Promise.reject(new Error("The browser worker is stopping."));
    let target: BrowserFrameTarget, owner: Owner, ownerId: string;
    try {
      target = targetForWorker(value, this.pid); owner = this.readOwner(); ownerId = owner.id;
      if (!identity(ownerId)) throw new Error("The browser worker has no valid owner.");
      if (this.#closing) throw new Error("The browser worker is stopping.");
    } catch (error) { return Promise.reject(error); }
    const key = JSON.stringify([target.name, target.targetId]);
    if (this.#pending.has(key) || this.#pending.size >= 8) return Promise.reject(new Error("Browser observation concurrency limit reached."));
    const current = () => {
      const latest = this.readOwner();
      if (this.#closing || latest !== owner || owner.id !== ownerId) throw new Error("The browser owner changed during observation.");
    };
    const completion = Promise.withResolvers<WorkerBrowserObservation>();
    const task: { promise: Promise<WorkerBrowserObservation>; failure?: { error: unknown } } = { promise: completion.promise };
    this.#pending.set(key, task);
    void (async () => {
      const native = await this.load();
      current();
      if (typeof native.inspectTabForOwner !== "function") throw new Error("This host's pinned browser does not support original-owner observation.");
      let result: WorkerBrowserObservation;
      try { result = projection(await native.inspectTabForOwner(ownerId, { name: target.name, targetId: target.targetId }), target, ownerId, true); }
      catch (error) { task.failure = { error }; throw error; }
      current();
      return result;
    })().then(completion.resolve, completion.reject);
    void task.promise.then(() => this.#pending.delete(key), () => this.#pending.delete(key));
    return task.promise;
  }

  dispose(): Promise<void> {
    if (this.#closing) return this.#closing;
    const completion = Promise.withResolvers<void>(); this.#closing = completion.promise;
    const tasks = [...this.#pending.values()];
    void Promise.allSettled(tasks.map(task => task.promise)).then(() => {
      const errors = tasks.flatMap(task => task.failure ? [task.failure.error] : []);
      if (errors.length) completion.reject(new AggregateError(errors, "Browser observation cleanup failed."));
      else completion.resolve();
    });
    return completion.promise;
  }
}

/** The daemon keeps the original worker/owner envelope and never imports native OMP. */
export async function requestWorkerBrowserObservation(client: {
  pid: number;
  request(operation: { operation: "inspectBrowserTab"; args: { target: BrowserFrameTarget } }): Promise<unknown>;
}, ownerId: string, value: BrowserFrameTarget): Promise<WorkerBrowserObservation> {
  const target = targetForWorker(value, client.pid);
  if (!identity(ownerId)) throw new Error("The browser worker has no valid owner.");
  const result = await client.request({ operation: "inspectBrowserTab", args: { target: { ...target } } });
  return parseWorkerBrowserObservation(result, target, ownerId);
}
