import type { NativeCdpEvaluation, NativeCmuxEvaluation } from "./evaluation-wire";
import { realpath, stat } from "node:fs/promises";
import { parseNativeBrowserTabMetadata, type NativeBrowserTabMetadata } from "@agent-desktop/shared";
import type { OmpBrowserTabCreateResult } from "../omp";

export interface BrowserOwnerOptions { id: string; cwd: string; agentDir?: string }
export interface BrowserEvaluationReservation {
  readonly ownerSessionId: string;
  readonly name: string;
  readonly targetId: string;
  readonly operationId: string;
  readonly ready: Promise<void>;
  assertCurrent(): void;
  dispose(options?: { readonly kill?: boolean }): Promise<void>;
}
interface NativeCreation extends Omit<NativeBrowserTabMetadata, "state"> {
  created: true;
  ownerSessionId: string;
  targetDisposition: OmpBrowserTabCreateResult["targetDisposition"];
}
/** Loaded inside the browser-only child. The loader never creates a native session. */
export interface BrowserOwnerBackend {
  create(signal: AbortSignal, request: { name: string; initialUrl?: string }): Promise<NativeCreation>;
  reserveEvaluation?(target: Readonly<{ name: string; targetId: string }>, operationId: string): Readonly<BrowserEvaluationReservation>;
  openCdpEvaluation?(target: Readonly<{ name: string; targetId: string }>, operationId: string, timeoutMs: number): Promise<Readonly<NativeCdpEvaluation>>;
  openCmuxEvaluation?(target: Readonly<{ name: string; targetId: string }>, operationId: string): Readonly<NativeCmuxEvaluation>;
  release(): Promise<void>;
}

async function loadNativeOwner(options: Readonly<BrowserOwnerOptions>): Promise<BrowserOwnerBackend> {
  const cwd = await realpath(options.cwd);
  if (cwd !== options.cwd || !(await stat(cwd)).isDirectory()) throw new Error("Browser owner requires its admitted canonical directory");
  const browser = await import("@oh-my-pi/pi-coding-agent/tools/browser") as unknown as {
    BROWSER_TAB_OWNER_CREATE_VERSION?: number;
    BROWSER_TAB_CREATE_INITIAL_URL_VERSION?: number;
    createBrowserTabForOwner?: (owner: { id: string; cwd: string; settings: unknown; signal: AbortSignal }, request: { name: string; initialUrl?: string }) => Promise<NativeCreation>;
  };
  const supervisor = await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") as unknown as {
    releaseTabsForOwner(ownerId: string, options: { kill: boolean; timeoutMs: number }): Promise<number>;
    BROWSER_TAB_EVALUATION_RESERVATION_VERSION?: number;
    BROWSER_CDP_EVALUATION_CHANNEL_VERSION?: number;
    BROWSER_CMUX_EVALUATION_CHANNEL_VERSION?: number;
    openReservedCdpEvaluation?(ownerId: string, target: Readonly<{ name: string; targetId: string }>, operationId: string, timeoutMs: number): Promise<Readonly<NativeCdpEvaluation>>;
    openReservedCmuxEvaluation?(ownerId: string, target: Readonly<{ name: string; targetId: string }>, operationId: string): Readonly<NativeCmuxEvaluation>;
    reserveTabEvaluationForOwner?(ownerId: string, target: Readonly<{ name: string; targetId: string }>, operationId: string): Readonly<BrowserEvaluationReservation>;
  };
  if (browser.BROWSER_TAB_OWNER_CREATE_VERSION !== 1 || browser.BROWSER_TAB_CREATE_INITIAL_URL_VERSION !== 1
    || typeof browser.createBrowserTabForOwner !== "function" || typeof supervisor.releaseTabsForOwner !== "function") {
    throw new Error("Pinned OMP does not support explicit browser ownership; no session fallback is permitted");
  }
  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const settings = await Settings.loadReadOnly({ cwd, agentDir: options.agentDir });
  const create = browser.createBrowserTabForOwner;
  return {
    create: (signal, request) => create({ id: options.id, cwd, settings, signal }, request),
    reserveEvaluation: (target, operationId) => {
      if (supervisor.BROWSER_TAB_EVALUATION_RESERVATION_VERSION !== 1 || typeof supervisor.reserveTabEvaluationForOwner !== "function") {
        throw new Error("Pinned OMP does not support original-resource evaluator reservation");
      }
      return supervisor.reserveTabEvaluationForOwner(options.id, target, operationId);
    },
    openCdpEvaluation: (target, operationId, timeoutMs) => {
      if (supervisor.BROWSER_CDP_EVALUATION_CHANNEL_VERSION !== 1 || typeof supervisor.openReservedCdpEvaluation !== "function") throw new Error("Pinned OMP does not support original reserved CDP evaluation");
      return supervisor.openReservedCdpEvaluation(options.id, target, operationId, timeoutMs);
    },
    openCmuxEvaluation: (target, operationId) => {
      if (supervisor.BROWSER_CMUX_EVALUATION_CHANNEL_VERSION !== 1 || typeof supervisor.openReservedCmuxEvaluation !== "function") throw new Error("Pinned OMP does not support original reserved cmux evaluation");
      return supervisor.openReservedCmuxEvaluation(options.id, target, operationId);
    },
    release: async () => { await supervisor.releaseTabsForOwner(options.id, { kill: true, timeoutMs: 10_000 }); },
  };
}

/** One isolated worker owns this lifetime. Client detachment is not disposal. */
export class NativeBrowserOwner {
  readonly #options: Readonly<BrowserOwnerOptions>;
  readonly #lifetime = new AbortController();
  readonly #backend: Promise<BrowserOwnerBackend>;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #reservations = new Map<string, { target: Readonly<{ name: string; targetId: string }>; promise: Promise<Readonly<BrowserEvaluationReservation>> }>();
  readonly #reservationCleanupErrors: unknown[] = [];
  #closing?: Promise<void>;

  constructor(options: BrowserOwnerOptions, load = loadNativeOwner) {
    if (!options || typeof options.id !== "string" || !options.id || options.id.length > 200
      || /[\u0000-\u001f\u007f]/.test(options.id) || typeof options.cwd !== "string" || !options.cwd) throw new Error("Invalid browser owner identity");
    this.#options = Object.freeze({ ...options });
    // Defer the loader so the lifetime is assigned before initialization can fail.
    this.#backend = Promise.resolve().then(() => load(this.#options));
    void this.#backend.catch(() => {});
  }

  get id(): string { this.#assertActive(); return this.#options.id; }
  get cwd(): string { return this.#options.cwd; }
  #assertActive(): void { if (this.#lifetime.signal.aborted) throw new Error("Browser owner is retired"); }
  async ready(): Promise<void> { await this.#backend; this.#assertActive(); }

  createBrowserTab(name: string, initialUrl?: string): Promise<OmpBrowserTabCreateResult> {
    this.#assertActive();
    const request = { name, ...(initialUrl === undefined ? {} : { initialUrl }) };
    const operation = (async () => {
      const backend = await this.#backend;
      this.#assertActive();
      const value = await backend.create(this.#lifetime.signal, request);
      this.#assertActive();
      if (value.created !== true || value.ownerSessionId !== this.#options.id || value.name !== name
        || !["created-page", "created-surface", "adopted-existing-target"].includes(value.targetDisposition)) throw new Error("Native browser creation returned a different owner or target");
      return { tab: parseNativeBrowserTabMetadata({ ...value, state: "alive" }), targetDisposition: value.targetDisposition };
    })();
    this.#pending.add(operation);
    void operation.then(() => this.#pending.delete(operation), () => this.#pending.delete(operation));
    return operation;
  }

  /** Original browser-only child retains this handle across the future fresh
   * session binding. A cancelled handoff cannot revive its retired evaluator. */
  reserveBrowserEvaluation(target: Readonly<{ name: string; targetId: string }>, operationId: string): Promise<Readonly<BrowserEvaluationReservation>> {
    this.#assertActive();
    const valid = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
    if (!target || !valid(target.name) || !valid(target.targetId) || !valid(operationId)) throw new Error("Invalid browser evaluation reservation");
    const request = Object.freeze({ name: target.name, targetId: target.targetId });
    const prior = this.#reservations.get(operationId);
    if (prior) {
      if (prior.target.name !== request.name || prior.target.targetId !== request.targetId) throw new Error("Browser reservation operation changed target");
      return prior.promise;
    }
    // Defer backend entry until the exact operation is registered. Synchronous
    // backend callbacks may dispose the owner or repeat this operation.
    const promise = Promise.resolve().then(async () => {
      const backend = await this.#backend;
      this.#assertActive();
      if (!backend.reserveEvaluation) throw new Error("Browser evaluation reservation is unavailable");
      const value = backend.reserveEvaluation(request, operationId);
      if (value.ownerSessionId !== this.#options.id || value.name !== request.name || value.targetId !== request.targetId || value.operationId !== operationId) {
        // A returned native reservation already owns cleanup, even when its
        // publication fails validation. Retire it before reporting failure.
        const mismatch = new Error("Native browser reservation returned a different original target");
        try { await value.dispose({ kill: true }); } catch (error) {
          this.#reservationCleanupErrors.push(error);
          throw new AggregateError([mismatch, error], "Invalid browser reservation cleanup failed");
        }
        throw mismatch;
      }
      const ready = value.ready.then(() => { this.#assertActive(); value.assertCurrent(); });
      void ready.catch(() => {});
      return Object.freeze({ ownerSessionId: value.ownerSessionId, name: value.name, targetId: value.targetId, operationId: value.operationId, ready,
        assertCurrent: () => { this.#assertActive(); value.assertCurrent(); },
        dispose: (options?: { readonly kill?: boolean }) => value.dispose(options),
      });
    });
    this.#reservations.set(operationId, { target: request, promise });
    void promise.catch(() => {});
    return promise;
  }

  /** Access only: ready-reservation admission is owned by the worker receipt
   * registry. Native supervisor independently checks that same original record. */
  async openBrowserEvaluation(target: Readonly<{ name: string; targetId: string }>, operationId: string, backendKind: "cdp" | "cmux", timeoutMs: number): Promise<Readonly<NativeCdpEvaluation> | Readonly<NativeCmuxEvaluation>> {
    this.#assertActive();
    const captured = { name: target.name, targetId: target.targetId };
    const backend = await this.#backend;
    this.#assertActive();
    if (backendKind === "cdp") {
      if (!backend.openCdpEvaluation) throw new Error("Original CDP evaluation is unavailable");
      return backend.openCdpEvaluation(captured, operationId, timeoutMs);
    }
    if (backendKind !== "cmux" || !backend.openCmuxEvaluation) throw new Error("Original cmux evaluation is unavailable");
    return backend.openCmuxEvaluation(captured, operationId);
  }

  dispose(): Promise<void> {
    if (this.#closing) return this.#closing;
    // Install retained teardown before synchronous abort listeners can re-enter.
    const closing = Promise.withResolvers<void>();
    this.#closing = closing.promise;
    this.#lifetime.abort();
    void (async () => {
      let backend: BrowserOwnerBackend;
      try { backend = await this.#backend; }
      catch { return; } // Initialization cannot have admitted any acquisition.
      await Promise.allSettled([...this.#pending]);
      // Every admitted reservation drains independently. One failure must not
      // skip the remaining resources or the original owner's release.
      const outcomes = await Promise.allSettled([...this.#reservations.values()].map(async ({ promise }) => {
        let reservation: Readonly<BrowserEvaluationReservation>;
        try { reservation = await promise; } catch { return; } // No published handle; failed publication performs its own cleanup.
        await reservation.dispose({ kill: true });
      }));
      try { await backend.release(); } catch (error) { outcomes.push({ status: "rejected", reason: error }); }
      const failures = [...new Set([...this.#reservationCleanupErrors, ...outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : [])])];
      if (failures.length) throw new AggregateError(failures, "Browser owner reservation cleanup failed");
    })().then(closing.resolve, closing.reject);
    return this.#closing;
  }
}
