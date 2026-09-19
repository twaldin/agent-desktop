import {
  parseTodoExternalEditorCapabilities,
  parseTodoExternalEditorCursor,
  parseTodoExternalEditorList,
  parseTodoExternalEditorObservation,
  parseTodoExternalEditorRecovery,
  parseTodoExternalEditorRequest,
  type TodoExternalEditorCapabilities,
  type TodoExternalEditorList,
  type TodoExternalEditorObservation,
  type TodoExternalEditorRequest,
  type TodoExternalEditorRecovery,
} from "../../../packages/shared/src/todo-external-editor";
import { MAX_TODO_BYTES, SESSION_TODOS_OWNER_HEADER } from "../../../packages/shared/src/session-todos";
import type { TodoExternalEditors } from "./todo-external-editors";

export type TodoExternalEditorHttpAction = "capabilities" | "list" | "start" | "status" | "cancel" | "recovery";

const REQUEST_LIMIT = MAX_TODO_BYTES * 6 + 64 * 1024;
// Recovery may carry both an unknown receipt snapshot and the retained output;
// JSON escaping can expand each valid 8 MiB UTF-8 value by six times.
const RESPONSE_LIMIT = 32 * 1024 * 1024;

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing Todo editor request body.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, 5_000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired) throw new Error("Todo editor request body timed out.");
      if (part.done) break;
      size += part.value.byteLength;
      if (size > REQUEST_LIMIT) throw new Error("Todo editor request body exceeds its limit.");
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

/** Authenticated, owner-bound HTTP projection for original Todo editor jobs.
 * Route parsing remains in the server; this handler accepts no command, path,
 * environment, or replacement-worker input from the client. */
export class TodoExternalEditorHttp {
  constructor(private readonly options: {
    hostId: string;
    sessionExists(id: string): boolean;
    service: Pick<TodoExternalEditors, "capabilities" | "list" | "start" | "observe" | "cancel" | "recovery">;
  }) {}

  async route(request: Request, sessionId: string, action: TodoExternalEditorHttpAction): Promise<Response> {
    const headers = { "Cache-Control": "no-store", [SESSION_TODOS_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, code: string, message: string) =>
      Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_TODOS_OWNER_HEADER) !== this.options.hostId)
      return fail(409, "OWNER_MISMATCH", "The Todo editor owner does not match this host.");
    let target: string, cursor: string | undefined;
    try {
      const url = new URL(request.url);
      if (action === "list") {
        if ([...url.searchParams.keys()].some(key => key !== "cursor") || url.searchParams.getAll("cursor").length > 1)
          throw new Error("Unexpected list query.");
        const rawCursor = url.searchParams.get("cursor");
        cursor = rawCursor === null ? undefined : parseTodoExternalEditorCursor(rawCursor);
      } else if (url.search) throw new Error("Unexpected query.");
      target = decodeURIComponent(sessionId);
      if (!target || target.includes("\0") || new TextEncoder().encode(target).byteLength > 200)
        throw new Error("Invalid session target.");
    } catch {
      return fail(400, "INVALID_TODO_EDITOR_REQUEST", "Invalid Todo editor session target.");
    }
    if (action === "capabilities" || action === "list") {
      if (request.method !== "GET")
        return fail(405, "INVALID_TODO_EDITOR_REQUEST", "Use GET to inspect Todo editor state.");
    } else if (action === "start" || action === "status" || action === "cancel" || action === "recovery") {
      if (request.method !== "POST")
        return fail(405, "INVALID_TODO_EDITOR_REQUEST", "Use POST for Todo editor requests.");
    } else {
      return fail(404, "INVALID_TODO_EDITOR_REQUEST", "Unknown Todo editor action.");
    }
    if (action === "capabilities") {
      if (!this.options.sessionExists(target))
        return fail(409, "STALE_TARGET", "The original Todos session no longer exists.");
      try {
        const value = parseTodoExternalEditorCapabilities(await this.options.service.capabilities(target), this.options.hostId);
        if (!this.options.sessionExists(target))
          return fail(409, "STALE_TARGET", "The original Todos session retired during capability inspection.");
        return this.#json(value, headers, fail);
      } catch {
        return fail(409, "TODO_EDITOR_UNAVAILABLE", "The original Todo editor capability could not be read.");
      }
    }
    if (action === "list") {
      try {
        return this.#json(parseTodoExternalEditorList(this.options.service.list(target, cursor), this.options.hostId, target), headers, fail);
      } catch {
        return fail(400, "INVALID_TODO_EDITOR_REQUEST", "Invalid Todo editor list request.");
      }
    }

    let input: TodoExternalEditorRequest;
    try {
      input = parseTodoExternalEditorRequest(await readBody(request));
      if (input.sessionId !== target) throw new Error("Session target mismatch.");
    } catch {
      return fail(400, "INVALID_TODO_EDITOR_REQUEST", "Invalid Todo editor request.");
    }
    if (action === "start" && !this.options.sessionExists(target))
      return fail(409, "STALE_TARGET", "The original Todos session no longer exists.");

    try {
      let value: TodoExternalEditorObservation | TodoExternalEditorRecovery;
      if (action === "start") value = parseTodoExternalEditorObservation(this.options.service.start(input), this.options.hostId, input);
      else if (action === "status") value = parseTodoExternalEditorObservation(this.options.service.observe(input), this.options.hostId, input);
      else if (action === "cancel") value = parseTodoExternalEditorObservation(await this.options.service.cancel(input), this.options.hostId, input);
      else if (action === "recovery") {
        const observation = this.options.service.observe(input);
        const recovered = this.options.service.recovery(input);
        value = parseTodoExternalEditorRecovery({ observation,
          ...(recovered ?? {}) }, this.options.hostId, input);
      } else {
        action satisfies never;
        throw new Error("Unknown Todo editor action.");
      }
      return this.#json(value, headers, fail);
    } catch {
      return fail(409, "TODO_EDITOR_UNAVAILABLE", "The original Todo editor request could not be completed. Inspect its status before trying again.");
    }
  }

  #json(value: TodoExternalEditorCapabilities | TodoExternalEditorList | TodoExternalEditorObservation | TodoExternalEditorRecovery,
    headers: Record<string, string>, fail: (status: number, code: string, message: string) => Response): Response {
    const body = JSON.stringify(value);
    if (new TextEncoder().encode(body).byteLength > RESPONSE_LIMIT)
      return fail(413, "TODO_EDITOR_RESPONSE_TOO_LARGE", "The complete Todo editor result exceeds the transport limit.");
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  }
}
