import { BROWSER_METADATA_OWNER_HEADER, validBrowserFrameTarget, type BrowserFrameTarget } from "@agent-desktop/shared";
import type { DraftBrowserAdmissionRequest } from "./browser-draft-admission";
import { readBrowserCreateBody } from "./browser-create-http";
import { parseWorkerBrowserObservation, type WorkerBrowserObservation } from "./omp-browser/observation";

type ObservationOwner = { kind: "session"; sessionId: string }
  | { kind: "draft"; ownerId: string; draftId: string; draftRevision: number };
interface ObservationHandle {
  id: string;
  workerPid: number;
  workerFailure?: { message: string };
  inspectBrowserTab(target: BrowserFrameTarget): Promise<WorkerBrowserObservation>;
}
interface Read {
  promise: Promise<{ value: WorkerBrowserObservation; handle: ObservationHandle }>;
  failure?: { error: unknown };
}
class ObservationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const invalid = () => new ObservationError("Invalid browser observation request.", 400, "INVALID_BROWSER_OBSERVATION_REQUEST");

/** Lookup-only observations. Pending lookup and read work shares a host-wide bound;
 * completed observations are never cached or treated as creation/close receipts. */
export class BrowserObservationHttp {
  private readonly pending = new Map<string, Read>();
  private closing?: Promise<void>;
  constructor(private readonly options: {
    hostId: string;
    sessionExists(id: string): boolean;
    getSessionHandle(id: string): Promise<ObservationHandle | undefined>;
    draftReady(owner: DraftBrowserAdmissionRequest): boolean;
    getDraftHandle(owner: DraftBrowserAdmissionRequest): Promise<ObservationHandle | undefined>;
  }) {}

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const session = /^\/v1\/sessions\/([^/]+)\/browser-target-observation$/.exec(url.pathname);
    const draft = /^\/v1\/draft-browser-owners\/([^/]+)\/target-observation$/.exec(url.pathname);
    if (!session && !draft) return undefined;
    const headers = { "Cache-Control": "no-store", [BROWSER_METADATA_OWNER_HEADER]: this.options.hostId };
    try {
      if (request.headers.get(BROWSER_METADATA_OWNER_HEADER) !== this.options.hostId) throw new ObservationError("The browser owner does not match this host.", 409, "OWNER_MISMATCH");
      if (request.method !== (session ? "GET" : "POST")) throw new ObservationError("Unsupported browser observation method.", 405, "INVALID_BROWSER_OBSERVATION_REQUEST");
      this.running();
      let owner: ObservationOwner, target: BrowserFrameTarget;
      try {
        const id = decodeURIComponent((session ?? draft)![1]!);
        if (!identity(id)) throw invalid();
        let input: unknown;
        if (session) {
          const keys = [...url.searchParams.keys()];
          if (keys.length !== 3 || !["workerPid", "name", "targetId"].every(key => url.searchParams.getAll(key).length === 1)) throw invalid();
          owner = { kind: "session", sessionId: id };
          input = { workerPid: Number(url.searchParams.get("workerPid")), name: url.searchParams.get("name"), targetId: url.searchParams.get("targetId") };
        } else {
          if (url.search) throw invalid();
          const body = await readBrowserCreateBody(request);
          if (!record(body) || Object.keys(body).some(key => !["draftId", "draftRevision", "target"].includes(key))
            || !identity(body.draftId) || !Number.isSafeInteger(body.draftRevision) || (body.draftRevision as number) < 1) throw invalid();
          owner = { kind: "draft", ownerId: id, draftId: body.draftId, draftRevision: body.draftRevision as number };
          input = body.target;
        }
        if (!record(input) || Object.keys(input).length !== 3 || !validBrowserFrameTarget(input)) throw invalid();
        target = { workerPid: input.workerPid, name: input.name, targetId: input.targetId };
      } catch { throw invalid(); }
      this.current(owner);
      const key = JSON.stringify([owner, target]);
      let read = this.pending.get(key);
      if (!read) {
        if (this.pending.size >= 8) throw new ObservationError("This host is inspecting other browser targets. Try again shortly.", 429, "BROWSER_OBSERVATION_BUSY");
        const completion = Promise.withResolvers<{ value: WorkerBrowserObservation; handle: ObservationHandle }>();
        read = { promise: completion.promise };
        this.pending.set(key, read); // Retain before lookup can call out or retire the owner.
        void this.inspect(owner, target, read).then(completion.resolve, completion.reject);
        void read.promise.then(() => this.pending.delete(key), () => this.pending.delete(key));
      }
      const { value, handle } = await read.promise;
      this.current(owner, target, handle);
      return Response.json({ protocolVersion: 1, hostId: this.options.hostId, owner, ...value }, { headers });
    } catch (error) {
      return Response.json({ error: { code: error instanceof ObservationError ? error.code : "BROWSER_OBSERVATION_FAILED",
        message: error instanceof ObservationError ? error.message : "The original browser target could not be inspected." } },
      { status: error instanceof ObservationError ? error.status : 503, headers });
    }
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>(); this.closing = completion.promise;
    const reads = [...this.pending.values()];
    void Promise.allSettled(reads.map(read => read.promise)).then(() => {
      const errors = reads.flatMap(read => read.failure ? [read.failure.error] : []);
      if (errors.length) completion.reject(new AggregateError(errors, "Browser observation cleanup failed."));
      else completion.resolve();
    });
    return this.closing;
  }

  private running() {
    if (this.closing) throw new ObservationError("Browser observations are stopping.", 503, "BROWSER_OBSERVATION_STOPPING");
  }
  private request(owner: Extract<ObservationOwner, { kind: "draft" }>): DraftBrowserAdmissionRequest {
    return { hostId: this.options.hostId, ownerId: owner.ownerId, draftId: owner.draftId, draftRevision: owner.draftRevision };
  }
  private current(owner: ObservationOwner, target?: BrowserFrameTarget, handle?: ObservationHandle) {
    this.running();
    const ready = owner.kind === "session" ? this.options.sessionExists(owner.sessionId) : this.options.draftReady(this.request(owner));
    this.running(); // A readiness callback may synchronously begin retirement.
    if (!ready || target && (!handle || handle.workerFailure || handle.workerPid !== target.workerPid
      || handle.id !== (owner.kind === "session" ? owner.sessionId : owner.ownerId))) {
      throw new ObservationError("The original browser owner or worker is no longer available.", 409, "STALE_TARGET");
    }
  }
  private lookup(owner: ObservationOwner) {
    return owner.kind === "session" ? this.options.getSessionHandle(owner.sessionId) : this.options.getDraftHandle(this.request(owner));
  }
  private async inspect(owner: ObservationOwner, target: BrowserFrameTarget, read: Read) {
    const handle = await this.lookup(owner);
    this.current(owner, target, handle);
    if (typeof handle!.inspectBrowserTab !== "function") throw new Error("This worker does not support original-owner observation.");
    let raw: unknown;
    try { raw = await handle!.inspectBrowserTab({ ...target }); }
    catch (error) { read.failure = { error }; throw error; }
    let value: WorkerBrowserObservation;
    try { value = parseWorkerBrowserObservation(raw, target, owner.kind === "session" ? owner.sessionId : owner.ownerId); }
    catch (error) { read.failure = { error }; throw error; }
    this.current(owner, target, handle);
    const latest = await this.lookup(owner);
    this.current(owner, target, handle);
    if (latest !== handle) throw new ObservationError("The browser worker changed while its target was inspected.", 409, "STALE_TARGET");
    return { value, handle: handle! };
  }
}
