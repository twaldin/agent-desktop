import { createHash } from "node:crypto";
import {
  GOAL_CONTROL_MAX_AGE_MS,
  GOAL_CONTROL_PROTOCOL_VERSION,
  SESSION_ACTIVITY_OWNER_HEADER,
  parseGoalMutationRequest,
  parseNativeGoalActivity,
  goalControlState,
  type GoalControlTicket,
  type GoalMutationReceipt,
  type GoalMutationRequest,
  type NativeGoalActivity,
  type NativeSessionActivity,
} from "@agent-desktop/shared";

export interface GoalControlHandle {
  workerFailure?: { message: string };
  getSessionActivity(): Promise<NativeSessionActivity>;
  mutateGoal(request: GoalMutationRequest): Promise<NativeGoalActivity | null>;
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing goal mutation body.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5_000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired) throw new Error("Goal mutation body timed out.");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32 * 1024) throw new Error("Goal mutation body exceeds its limit.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer); reader.releaseLock();
  }
}

function fingerprint(goal: NativeGoalActivity | null): string {
  return createHash("sha256").update(goalControlState(goal)).digest("hex");
}

/** Owner-bound, idempotent admission for native goal state changes. The exact
 * effective configuration is fingerprinted because native updatedAt also
 * advances on usage accounting and is not a configuration revision. */
export class GoalControlHttp {
  readonly epoch = crypto.randomUUID();
  private receipts = new Map<string, { hash: string; createdAt: number; settled: boolean; result: Promise<GoalMutationReceipt> }>();

  constructor(private options: {
    hostId: string;
    sessionExists(id: string): boolean;
    getHandle(id: string): Promise<GoalControlHandle>;
    getExistingHandle(id: string): Promise<GoalControlHandle | undefined>;
    ordered<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
    completed?(sessionId: string, input: GoalMutationRequest, goal: NativeGoalActivity | null): void;
    now?: () => number;
  }) {}

  ticket(activity: NativeSessionActivity): GoalControlTicket | undefined {
    if (activity.goal.availability !== "available") return undefined;
    try {
      return { controlEpoch: this.epoch, observedAt: (this.options.now ?? Date.now)(), goalFingerprint: fingerprint(activity.goal.value) };
    } catch {
      // An old or malformed projection remains readable, but it is never an
      // authority ticket for a mutation this host cannot validate.
      return undefined;
    }
  }

  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/goal-control$/.exec(url.pathname);
    if (!match) return undefined;
    const headers = { "Cache-Control": "no-store", [SESSION_ACTIVITY_OWNER_HEADER]: this.options.hostId };
    const errorResponse = (message: string, status: number, code: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_ACTIVITY_OWNER_HEADER) !== this.options.hostId) {
      return errorResponse("The selected session owner no longer matches this endpoint.", 409, "OWNER_MISMATCH");
    }
    if (request.method !== "POST") return errorResponse("Use POST for goal mutations.", 405, "INVALID_GOAL_CONTROL_REQUEST");
    let sessionId: string, input: GoalMutationRequest;
    try {
      sessionId = decodeURIComponent(match[1]!);
      if (!sessionId || sessionId.length > 200 || sessionId.includes("\0")) throw new Error("Invalid session identity.");
      input = parseGoalMutationRequest(await readBody(request));
    } catch {
      return errorResponse("Invalid goal mutation request.", 400, "INVALID_GOAL_CONTROL_REQUEST");
    }
    const base = { protocolVersion: GOAL_CONTROL_PROTOCOL_VERSION, hostId: this.options.hostId, sessionId, requestId: input.requestId };
    const receipt = (outcome: "rejected" | "unknown", message: string, goal?: NativeGoalActivity | null): GoalMutationReceipt =>
      ({ ...base, outcome, message, ...(goal === undefined ? {} : { goal }) });
    const reject = (message: string) => Response.json(receipt("rejected", message), { headers });
    const now = (this.options.now ?? Date.now)();
    for (const [key, record] of this.receipts) if (record.settled && now - record.createdAt > GOAL_CONTROL_MAX_AGE_MS * 2) this.receipts.delete(key);
    const key = `${sessionId}:${input.requestId}`, hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = this.receipts.get(key);
    if (prior) return Response.json(prior.hash === hash ? await prior.result : receipt("rejected", "This goal mutation identity was already used for different input."), { headers });
    if (input.controlEpoch !== this.epoch) return reject("The session host restarted. Refresh its goal before changing it.");
    if (input.observedAt > now + 5_000 || now - input.observedAt > GOAL_CONTROL_MAX_AGE_MS) return reject("The goal snapshot is too old. Refresh before changing it.");
    if (this.receipts.size >= 4_096) return reject("This host is handling too many goal mutations. Wait before trying again.");

    const result = this.options.ordered(sessionId, async (): Promise<GoalMutationReceipt> => {
      if (!this.options.sessionExists(sessionId)) return receipt("rejected", "The selected session is no longer available.");
      let handle: GoalControlHandle;
      try { handle = await this.options.getHandle(sessionId); }
      catch { return receipt("rejected", "The native session could not be opened for goal control."); }
      if (handle.workerFailure) return receipt("rejected", "The native session worker is unavailable.");
      let current: NativeGoalActivity | null;
      try {
        const activity = await handle.getSessionActivity();
        if (activity.goal.availability !== "available") return receipt("rejected", "Native goal state is unavailable for this session.");
        current = activity.goal.value === null ? null : parseNativeGoalActivity(activity.goal.value);
      } catch { return receipt("rejected", "Native goal state could not be read."); }
      if (fingerprint(current) !== input.goalFingerprint) return receipt("rejected", "The native goal changed. Refresh before trying again.", current);
      if (input.expectedGoal === null ? current !== null : !current || current.id !== input.expectedGoal.id) {
        return receipt("rejected", "The native goal changed. Refresh before trying again.", current);
      }
      try {
        const goal = await handle.mutateGoal(input);
        if (!this.options.sessionExists(sessionId) || handle.workerFailure || await this.options.getExistingHandle(sessionId) !== handle) {
          return receipt("unknown", "The native session changed during the goal mutation. Refresh its activity before acting again.");
        }
        const bounded = goal === null ? null : parseNativeGoalActivity(goal);
        this.options.completed?.(sessionId, input, bounded);
        return { ...base, outcome: "completed", goal: bounded };
      } catch (error) {
        return error instanceof Error && error.name === "GoalMutationRejected" && !("code" in error && error.code === "OUTCOME_UNKNOWN")
          ? receipt("rejected", "The native session rejected this goal mutation. Refresh its activity and try again.")
          : receipt("unknown", "The goal mutation may have reached the native session. Refresh its activity before acting again.");
      }
    });
    const record = { hash, createdAt: now, settled: false, result };
    this.receipts.set(key, record);
    void result.finally(() => { record.settled = true; }).catch(() => {});
    return Response.json(await result, { headers });
  }
}
