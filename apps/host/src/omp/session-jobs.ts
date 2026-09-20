import { randomUUID } from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { parseSessionJobsRequest, sameSessionJobsOwner, SESSION_JOBS_MAX_OUTPUT_CHARS, SESSION_JOBS_MAX_PENDING_IDS, SESSION_JOBS_MAX_RECENT,
  SESSION_JOBS_MAX_RUNNING, type SessionJobDetail, type SessionJobRow, type SessionJobsOwner, type SessionJobsRequest, type SessionJobsResult,
  type SessionJobsSnapshot, type SessionJobTarget } from "@agent-desktop/shared";

export type NativeJobsErrorCode = "STALE_OWNER" | "STALE_JOB" | "JOBS_REJECTED";
/** Every code means nothing native changed. The worker RPC preserves only the
 * error name, so the code is carried there as well. */
export class NativeJobsError extends Error {
  constructor(readonly code: NativeJobsErrorCode, message: string) { super(message); this.name = `NativeJobsError.${code}`; }
}
export function nativeJobsErrorCode(error: unknown): NativeJobsErrorCode | undefined {
  if (error instanceof NativeJobsError) return error.code;
  const match = error instanceof Error ? /^NativeJobsError\.(STALE_OWNER|STALE_JOB|JOBS_REJECTED)$/.exec(error.name) : null;
  return match ? match[1] as NativeJobsErrorCode : undefined;
}

/** The exact native surface the adapter reads; production passes the real AgentSession. */
export type NativeJobsSession = Pick<AgentSession, "sessionId" | "sessionFile" | "isDisposed" | "getAgentId" | "asyncJobManager" | "getAsyncJobSnapshot">;

/** One loaded native session's background jobs. Stores no jobs: every row is
 * projected from the native snapshot at request time and augmented from the
 * same manager. Reads never consume, acknowledge, watch or evict anything the
 * agent has not seen; the only control is a guarded single-job abort request. */
export class NativeSessionJobs {
  readonly #owner: SessionJobsOwner;
  readonly #sessionFile: string | undefined;
  readonly #manager: AsyncJobManager | undefined;
  /** Opaque identity of a live native job object, so a recycled id with a colliding
   * startTime cannot be addressed by a target minted for its predecessor. */
  readonly #guards = new WeakMap<AsyncJob, string>();
  constructor(private readonly session: NativeJobsSession, private readonly assertOwner: () => void) {
    const agentId = session.getAgentId();
    this.#owner = { nativeSessionId: session.sessionId, epoch: randomUUID(), ...(agentId ? { agentId } : {}) };
    this.#sessionFile = session.sessionFile;
    this.#manager = session.asyncJobManager;
    this.#assert();
  }
  get owner(): SessionJobsOwner { return { ...this.#owner }; }

  request(raw: SessionJobsRequest): SessionJobsResult {
    let request: SessionJobsRequest;
    try { request = parseSessionJobsRequest(raw); }
    catch (error) { throw new NativeJobsError("JOBS_REJECTED", error instanceof Error ? error.message : String(error)); }
    this.#assert();
    if (request.owner && !sameSessionJobsOwner(request.owner, this.#owner))
      throw new NativeJobsError("STALE_OWNER", "These jobs belong to another native owner generation. Refresh before inspecting or cancelling.");
    if (request.action === "read") return { action: "read", snapshot: this.#snapshot() };
    const manager = this.#manager;
    if (!manager) throw new NativeJobsError("STALE_JOB", "This native session has no asynchronous job manager.");
    const job = this.#resolve(manager, request.job);
    if (request.action === "inspect") {
      const bound = (value: string | undefined) => value !== undefined && value.length > SESSION_JOBS_MAX_OUTPUT_CHARS ? value.slice(0, SESSION_JOBS_MAX_OUTPUT_CHARS) : value;
      const resultText = bound(job.resultText), errorText = bound(job.errorText);
      const detail: SessionJobDetail = { target: { ...request.job }, ...(resultText === undefined ? {} : { resultText }), ...(errorText === undefined ? {} : { errorText }),
        truncated: resultText !== job.resultText || errorText !== job.errorText, consumed: manager.isJobResultConsumed(job.id) };
      return { action: "inspect", snapshot: this.#snapshot(), detail };
    }
    // Synchronous after the guard: the manager flips running → cancelled and aborts the
    // body's signal. `false` means the job already settled. Neither waits for the body.
    const requested = manager.cancel(job.id, this.#owner.agentId ? { ownerId: this.#owner.agentId } : undefined);
    return { action: "cancel", snapshot: this.#snapshot(), requested };
  }

  /** The runtime fence and the bound native identity are both required; either
   * failing means nothing native changed and every held target is stale. */
  #assert(): void {
    try { this.assertOwner(); }
    catch (error) { throw new NativeJobsError("STALE_OWNER", error instanceof Error ? error.message : String(error)); }
    const session = this.session;
    if (session.isDisposed || session.sessionId !== this.#owner.nativeSessionId || session.sessionFile !== this.#sessionFile
      || (session.getAgentId() || undefined) !== this.#owner.agentId || session.asyncJobManager !== this.#manager)
      throw new NativeJobsError("STALE_OWNER", "The original native jobs owner has retired.");
  }
  /** Mirrors the SDK's own snapshot filter: a truthy agent id scopes by ownerId, otherwise every job is visible. */
  #owned(job: AsyncJob): boolean { return !this.#owner.agentId || job.ownerId === this.#owner.agentId; }
  #resolve(manager: AsyncJobManager, target: SessionJobTarget): AsyncJob {
    const job = manager.getJob(target.id);
    if (!job || job.id !== target.id || job.startTime !== target.startTime || this.#guards.get(job) !== target.guard || !this.#owned(job))
      throw new NativeJobsError("STALE_JOB", "This job is no longer the one you inspected. Refresh the job list before acting.");
    return job;
  }
  #snapshot(): SessionJobsSnapshot {
    const manager = this.#manager, native = manager ? this.session.getAsyncJobSnapshot({ recentLimit: SESSION_JOBS_MAX_RECENT }) : null;
    if (!manager || !native) return { owner: this.owner, availability: "unavailable", reason: "This native session has no asynchronous job manager." };
    if (native.running.length > SESSION_JOBS_MAX_RUNNING || native.delivery.pendingJobIds.length > SESSION_JOBS_MAX_PENDING_IDS)
      throw new Error("The native jobs snapshot exceeds the desktop response limit; no partial job list was returned.");
    const row = (item: AsyncJobSnapshotItem): SessionJobRow => {
      // Same synchronous tick as the snapshot, so the manager still holds the projected job.
      const job = manager.getJob(item.id);
      if (!job || job.startTime !== item.startTime || !this.#owned(job)) throw new Error("The native job snapshot and its manager disagree.");
      let guard = this.#guards.get(job);
      if (!guard) { guard = randomUUID(); this.#guards.set(job, guard); }
      return { target: { id: job.id, startTime: job.startTime, guard }, type: job.type, status: job.status, label: job.label.slice(0, 500), queued: job.status === "running" && job.queued === true,
        ...(job.agentId ? { agentId: job.agentId.slice(0, 200) } : {}) };
    };
    return { owner: this.owner, availability: "available",
      running: native.running.map(row), recent: native.recent.map(row),
      delivery: { queued: native.delivery.queued, delivering: native.delivery.delivering,
        ...(native.delivery.nextRetryAt === undefined ? {} : { nextRetryAt: native.delivery.nextRetryAt }),
        pendingJobIds: [...native.delivery.pendingJobIds] } };
  }
}
