import {
  parsePlanExternalEditorCapabilities,
  parsePlanExternalEditorCursor,
  parsePlanExternalEditorList,
  parsePlanExternalEditorObservation,
  parsePlanExternalEditorRecovery,
  parsePlanExternalEditorRequest,
  type PlanExternalEditorCapabilities,
  type PlanExternalEditorList,
  type PlanExternalEditorObservation,
  type PlanExternalEditorRequest,
  type PlanExternalEditorRecovery,
} from "../../../packages/shared/src/plan-external-editor";
import { MAX_PLAN_ANNOTATION_BYTES } from "../../../packages/shared/src/plan-document";
import { MAX_PLAN_CONTENT_BYTES, SESSION_PLAN_OWNER_HEADER } from "../../../packages/shared/src/session-plan";
import type { PlanExternalEditors } from "./plan-external-editors";

export type PlanExternalEditorHttpAction = "capabilities" | "list" | "start" | "status" | "cancel" | "recovery";

const REQUEST_LIMIT = MAX_PLAN_ANNOTATION_BYTES * 6 + 64 * 1024;
// Recovery may carry both an unknown receipt snapshot and the retained output;
// JSON escaping can expand each valid 8 MiB UTF-8 value by six times.
const RESPONSE_LIMIT = MAX_PLAN_CONTENT_BYTES * 12 + 4 * 1024 * 1024;

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing Plan editor request body.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5_000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired) throw new Error("Plan editor request body timed out.");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > REQUEST_LIMIT) throw new Error("Plan editor request body exceeds its limit.");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Authenticated, owner-bound HTTP projection for original Plan editor jobs.
 * Route parsing remains in the server; this handler accepts no command, path,
 * environment, or replacement-worker input from the client. */
export class PlanExternalEditorHttp {
  constructor(private readonly options: {
    hostId: string;
    sessionExists(id: string): boolean;
    service: Pick<PlanExternalEditors, "capabilities" | "list" | "start" | "observe" | "cancel" | "recovery">;
  }) {}

  async route(request: Request, sessionId: string, action: PlanExternalEditorHttpAction): Promise<Response> {
    const headers = { "Cache-Control": "no-store", [SESSION_PLAN_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) =>
      Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_PLAN_OWNER_HEADER) !== this.options.hostId)
      return fail(409, "OWNER_MISMATCH", "The Plan editor owner does not match this host.");
    let target: string, cursor: string | undefined;
    try {
      const url = new URL(request.url);
      if (action === "list") {
        if ([...url.searchParams.keys()].some(key => key !== "cursor") || url.searchParams.getAll("cursor").length > 1)
          throw new Error("Unexpected list query.");
        const rawCursor = url.searchParams.get("cursor");
        cursor = rawCursor === null ? undefined : parsePlanExternalEditorCursor(rawCursor);
      } else if (url.search) throw new Error("Unexpected query.");
      target = decodeURIComponent(sessionId);
      if (!target || target.includes("\0") || new TextEncoder().encode(target).byteLength > 200)
        throw new Error("Invalid session target.");
    } catch {
      return fail(400, "INVALID_PLAN_EDITOR_REQUEST", "Invalid Plan editor session target.");
    }
    if (action === "capabilities" || action === "list") {
      if (request.method !== "GET")
        return fail(405, "INVALID_PLAN_EDITOR_REQUEST", "Use GET to inspect Plan editor state.");
    } else if (action === "start" || action === "status" || action === "cancel" || action === "recovery") {
      if (request.method !== "POST")
        return fail(405, "INVALID_PLAN_EDITOR_REQUEST", "Use POST for Plan editor requests.");
    } else {
      return fail(404, "INVALID_PLAN_EDITOR_REQUEST", "Unknown Plan editor action.");
    }
    if (action === "capabilities") {
      if (!this.options.sessionExists(target))
        return fail(409, "STALE_TARGET", "The original Plan session no longer exists.");
      try {
        const value = parsePlanExternalEditorCapabilities(await this.options.service.capabilities(target), this.options.hostId);
        if (!this.options.sessionExists(target))
          return fail(409, "STALE_TARGET", "The original Plan session retired during capability inspection.");
        return this.#json(value, headers, fail);
      } catch {
        return fail(409, "PLAN_EDITOR_UNAVAILABLE", "The original Plan editor capability could not be read.");
      }
    }
    if (action === "list") {
      try {
        return this.#json(parsePlanExternalEditorList(this.options.service.list(target, cursor), this.options.hostId, target), headers, fail);
      } catch {
        return fail(400, "INVALID_PLAN_EDITOR_REQUEST", "Invalid Plan editor list request.");
      }
    }

    let input: PlanExternalEditorRequest;
    try {
      input = parsePlanExternalEditorRequest(await readBody(request));
      if (input.sessionId !== target) throw new Error("Session target mismatch.");
    } catch {
      return fail(400, "INVALID_PLAN_EDITOR_REQUEST", "Invalid Plan editor request.");
    }
    if (action === "start" && !this.options.sessionExists(target))
      return fail(409, "STALE_TARGET", "The original Plan session no longer exists.");

    try {
      let value: PlanExternalEditorObservation | PlanExternalEditorRecovery;
      if (action === "start") value = parsePlanExternalEditorObservation(this.options.service.start(input), this.options.hostId, input);
      else if (action === "status") value = parsePlanExternalEditorObservation(this.options.service.observe(input), this.options.hostId, input);
      else if (action === "cancel") value = parsePlanExternalEditorObservation(await this.options.service.cancel(input), this.options.hostId, input);
      else if (action === "recovery") {
        const observation = this.options.service.observe(input);
        const content = this.options.service.recovery(input);
        value = parsePlanExternalEditorRecovery({ observation,
          ...(content === undefined ? {} : { content }) }, this.options.hostId, input);
      } else {
        action satisfies never;
        throw new Error("Unknown Plan editor action.");
      }
      return this.#json(value, headers, fail);
    } catch {
      return fail(409, "PLAN_EDITOR_UNAVAILABLE", "The original Plan editor request could not be completed. Inspect its status before trying again.");
    }
  }

  #json(value: PlanExternalEditorCapabilities | PlanExternalEditorList | PlanExternalEditorObservation | PlanExternalEditorRecovery,
    headers: Record<string, string>, fail: (status: number, code: string, message: string) => Response): Response {
    const body = JSON.stringify(value);
    if (new TextEncoder().encode(body).byteLength > RESPONSE_LIMIT)
      return fail(413, "PLAN_EDITOR_RESPONSE_TOO_LARGE", "The complete Plan editor result exceeds the transport limit.");
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  }
}
