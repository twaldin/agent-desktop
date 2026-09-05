import type { OmpModelDefinitionsMutation, OmpSessionControlMutation, OmpSettingsMutation, SettingJson, WorkspaceTarget } from "@agent-desktop/shared";
import type { WorkerRuntime, WorkerSession } from "./omp-workers";
import { OmpSettings, OmpSettingsError } from "./omp-settings";
import { parseWorkspaceTarget } from "./workspace-http";

class SettingsRequestError extends Error {}
class SettingsBusyError extends SettingsRequestError {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SettingsRequestError("Invalid settings request.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 200): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > maximum) throw new SettingsRequestError("Invalid settings identifier.");
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new SettingsRequestError("Unsupported settings request field.");
}
function jsonValue(value: unknown, depth = 0): SettingJson {
  if (depth > 32) throw new SettingsRequestError("Settings value is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
  const record = object(value);
  const output: Record<string, SettingJson> = {};
  for (const [key, item] of Object.entries(record)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new SettingsRequestError("Unsupported settings object key.");
    output[key] = jsonValue(item, depth + 1);
  }
  return output;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const limit = 1024 * 1024;
  if (Number(request.headers.get("Content-Length") ?? 0) > limit) throw new SettingsRequestError("Settings request exceeds 1 MiB.");
  if (!request.body) throw new SettingsRequestError("A settings request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new SettingsRequestError("Settings request exceeds 1 MiB."); }
      chunks.push(next.value);
    }
    try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new SettingsRequestError("Invalid settings JSON body."); }
  } finally { reader.releaseLock(); }
}
export function parseSettingsMutation(value: unknown): OmpSettingsMutation {
  const input = object(value);
  keys(input, ["expectedRevision", "scope", "path", "operation", "value"]);
  if (input.scope !== "global" && input.scope !== "project") throw new SettingsRequestError("Invalid native settings scope.");
  if (input.operation !== "set" && input.operation !== "reset") throw new SettingsRequestError("Invalid native settings operation.");
  if (input.operation === "reset" && Object.hasOwn(input, "value")) throw new SettingsRequestError("Reset does not accept a value.");
  return { expectedRevision: text(input.expectedRevision), scope: input.scope, path: text(input.path), operation: input.operation,
    ...(input.operation === "set" ? { value: jsonValue(input.value) } : {}) };
}
export function parseSessionControlMutation(value: unknown): OmpSessionControlMutation {
  const input = object(value);
  const expectedRevision = text(input.expectedRevision);
  switch (input.operation) {
    case "model": {
      keys(input, ["expectedRevision", "operation", "model"]);
      const model = object(input.model); keys(model, ["provider", "id"]);
      return { expectedRevision, operation: input.operation, model: { provider: text(model.provider), id: text(model.id, 1024) } };
    }
    case "thinking":
      keys(input, ["expectedRevision", "operation", "level"]);
      return { expectedRevision, operation: input.operation, ...(input.level === undefined ? {} : { level: text(input.level) }) };
    case "service-tier": {
      keys(input, ["expectedRevision", "operation", "family", "tier"]);
      if (typeof input.family !== "string" || !["openai", "anthropic", "google"].includes(input.family)
        || input.tier !== undefined && (typeof input.tier !== "string" || !["auto", "default", "flex", "scale", "priority"].includes(input.tier))) throw new SettingsRequestError("Invalid native service tier.");
      return { expectedRevision, operation: input.operation, family: input.family as "openai" | "anthropic" | "google", tier: input.tier as "auto" | "default" | "flex" | "scale" | "priority" | undefined };
    }
    case "override":
      keys(input, ["expectedRevision", "operation", "path", "value"]);
      return { expectedRevision, operation: input.operation, path: text(input.path), value: jsonValue(input.value) };
    case "clear-override":
      keys(input, ["expectedRevision", "operation", "path"]);
      return { expectedRevision, operation: input.operation, path: text(input.path) };
    default: throw new SettingsRequestError("Unknown native session control operation.");
  }
}
export function parseModelDefinitionsMutation(value: unknown): OmpModelDefinitionsMutation {
  const input = object(value); keys(input, ["expectedRevision", "changes"]);
  if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 100) throw new SettingsRequestError("A native model edit requires 1–100 changes.");
  return { expectedRevision: text(input.expectedRevision), changes: input.changes.map(raw => {
    const change = object(raw); keys(change, ["path", "operation", "value"]);
    if (!Array.isArray(change.path) || change.path.length < 2 || change.path.length > 32 || change.path[0] !== "providers") throw new SettingsRequestError("Select a native provider/model definition field.");
    const path = change.path.map(part => typeof part === "number" && Number.isInteger(part) && part >= 0 && part <= 10_000 ? part : text(part, 1024));
    if (change.operation === "set") return { path, operation: "set" as const, value: jsonValue(change.value) };
    if (change.operation === "remove" && !Object.hasOwn(change, "value")) return { path, operation: "remove" as const };
    throw new SettingsRequestError("Invalid native model definition operation.");
  }) };
}
export interface SettingsHttpOptions {
  agentDir?: string;
  defaultCwd: string;
  /** Must resolve only admitted catalog IDs. No HTTP filesystem paths are accepted. */
  resolveCwd(target?: WorkspaceTarget): Promise<string> | string;
  getHandle(sessionId: string): Promise<Pick<WorkerSession, "getControls" | "mutateControls">>;
  runtime: Pick<WorkerRuntime, "listModelCapabilities" | "getComposerCatalog">;
  changed(event: { target?: WorkspaceTarget; sessionId?: string; scope?: "global" | "project" }): void;
  /** Bounded idle cache. Active requests hold leases and cannot be evicted. */
  maxBackends?: number;
}

/** Called only after the owning server authenticates its peer. No mutation body,
 * secret value or runtime override is sent to a command/event journal. */
export class SettingsHttp {
  #backends = new Map<string, { pending: Promise<OmpSettings>; leases: number; touched: number }>();
  #operations = new Set<Promise<unknown>>();
  #clock = 0;
  #stopping = false;
  constructor(private options: SettingsHttpOptions) {
    if (options.maxBackends !== undefined && (!Number.isInteger(options.maxBackends) || options.maxBackends < 1)) throw new Error("Settings cache size must be a positive integer");
  }
  #target(value: unknown): WorkspaceTarget | undefined {
    if (value === undefined) return undefined;
    try { return parseWorkspaceTarget(value); }
    catch { throw new SettingsRequestError("Select an existing catalog project or session."); }
  }
  #withBackend<T>(target: WorkspaceTarget | undefined, use: (backend: OmpSettings) => T | Promise<T>): Promise<T> {
    const pending = this.#leaseBackend(target, use);
    this.#operations.add(pending);
    void pending.finally(() => this.#operations.delete(pending)).catch(() => {});
    return pending;
  }
  async #leaseBackend<T>(target: WorkspaceTarget | undefined, use: (backend: OmpSettings) => T | Promise<T>): Promise<T> {
    if (this.#stopping) throw new SettingsRequestError("The host is stopping.");
    const cwd = target === undefined ? this.options.defaultCwd : await this.options.resolveCwd(target);
    if (this.#stopping) throw new SettingsRequestError("The host is stopping.");
    let entry = this.#backends.get(cwd);
    if (!entry) {
      if (this.#backends.size >= (this.options.maxBackends ?? 32)) {
        const oldest = [...this.#backends.entries()].filter(([, value]) => value.leases === 0).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!oldest) throw new SettingsBusyError("Native settings are busy. Retry after the current settings request finishes.");
        this.#backends.delete(oldest[0]);
        // There are no active users of this service. Dispose has no native
        // credential resources; await it in this tracked request's finally.
        const retired = oldest[1].pending.then(backend => backend.dispose(), () => {});
        this.#operations.add(retired);
        void retired.finally(() => this.#operations.delete(retired)).catch(() => {});
      }
      entry = { pending: OmpSettings.open({ cwd, agentDir: this.options.agentDir }), leases: 0, touched: ++this.#clock };
      this.#backends.set(cwd, entry);
      const created = entry;
      void entry.pending.catch(() => { if (this.#backends.get(cwd) === created) this.#backends.delete(cwd); });
    }
    entry.leases++; entry.touched = ++this.#clock;
    try { return await use(await entry.pending); }
    finally { entry.leases--; entry.touched = ++this.#clock; }
  }
  async route(request: Request, url: URL): Promise<Response | undefined> {
    const sessionPath = /^\/v1\/sessions\/([^/]+)\/controls$/.exec(url.pathname);
    const settingsPath = url.pathname.startsWith("/v1/settings/");
    const modelsPath = ["/v1/models/capabilities", "/v1/models/composer"].includes(url.pathname);
    const definitionsPath = url.pathname === "/v1/models/definitions";
    if (!settingsPath && !sessionPath && !modelsPath && !definitionsPath) return;
    const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
    try {
      if (this.#stopping) throw new SettingsRequestError("The host is stopping.");
      if (definitionsPath && request.method === "GET") return await this.#withBackend(undefined, async backend => respond(await backend.readModelDefinitions()));
      if (definitionsPath && request.method === "POST") {
        const mutation = parseModelDefinitionsMutation(await body(request));
        return await this.#withBackend(undefined, async backend => {
          const snapshot = await backend.mutateModelDefinitions(mutation);
          this.options.changed({ scope: "global" });
          return respond(snapshot);
        });
      }
      if (sessionPath) {
        const sessionId = text(decodeURIComponent(sessionPath[1]));
        const handle = await this.options.getHandle(sessionId);
        if (request.method === "GET") return respond(await handle.getControls());
        if (request.method === "POST") {
          const result = await handle.mutateControls(parseSessionControlMutation(await body(request)));
          this.options.changed({ sessionId });
          return respond(result);
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/settings/catalog") return await this.#withBackend(undefined, backend => respond(backend.catalog()));
      if (request.method === "POST" && ["/v1/settings/read", "/v1/settings/mutate", "/v1/settings/options", "/v1/models/capabilities", "/v1/models/composer"].includes(url.pathname)) {
        const input = await body(request);
        const allowed = url.pathname.endsWith("mutate") ? ["target", "mutation"] : url.pathname.endsWith("options") ? ["target", "path"] : modelsPath ? ["target", "refresh"] : ["target"];
        keys(input, allowed);
        const target = this.#target(input.target);
        return await this.#withBackend(target, async backend => {
        if (modelsPath) {
          if (input.refresh !== undefined && typeof input.refresh !== "boolean") throw new SettingsRequestError("Invalid model refresh value.");
          if (url.pathname.endsWith("composer")) return respond(await this.options.runtime.getComposerCatalog(backend.cwd, { refresh: input.refresh as boolean | undefined }));
          return respond(await this.options.runtime.listModelCapabilities(backend.cwd, { refresh: input.refresh as boolean | undefined }));
        }
        if (url.pathname.endsWith("read")) return respond(await backend.read());
        if (url.pathname.endsWith("options")) return respond(await backend.options(text(input.path)));
        const mutation = parseSettingsMutation(input.mutation);
        if (mutation.scope === "project" && target === undefined) throw new SettingsRequestError("Project settings require a catalog project or session.");
        const result = await backend.mutate(mutation);
        this.options.changed({ target, scope: mutation.scope });
        return respond(result);
        });
      }
      return respond({ error: "Not found" }, 404);
    } catch (error) {
      const safe = error instanceof OmpSettingsError || error instanceof SettingsRequestError;
      const code = error instanceof OmpSettingsError ? error.code : "settings-request-failed";
      const status = error instanceof SettingsBusyError ? 503 : code === "conflict" ? 409 : code === "unsupported" ? 422 : 400;
      // Remote SDK/provider exception bodies can contain configuration secrets.
      return respond({ code, error: safe ? error.message : "Native settings request failed. Reload owning-host state before retrying." }, status);
    }
  }
  async dispose(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#operations]);
    const results = await Promise.allSettled([...this.#backends.values()].map(async entry => (await entry.pending).dispose()));
    this.#backends.clear();
    const errors = results.filter(result => result.status === "rejected");
    if (errors.length) throw new Error("One or more native settings services did not dispose cleanly");
  }
}
