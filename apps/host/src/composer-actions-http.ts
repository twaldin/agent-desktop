import { COMPOSER_OWNER_HEADER, type ComposerCompletionQuery, type WorkspaceTarget } from "@agent-desktop/shared";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { ComposerActionsCatalog, ComposerSkillDetail } from "@agent-desktop/shared";
import type { WorkerRuntime, WorkerSession } from "./omp-workers";
import { parseWorkspaceTarget } from "./workspace-http";

class ComposerRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID_COMPOSER_QUERY") { super(message); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComposerRequestError("Invalid composer request.");
  return value as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ComposerRequestError("Unsupported composer request field.");
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new ComposerRequestError("Composer query requires a body.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  let expired = false;
  const timeout = setTimeout(() => { expired = true; void reader.cancel("Composer body timed out"); }, 5000);
  try {
    for (;;) { const next = await reader.read(); if (expired) throw new ComposerRequestError("Composer request timed out.", 408); if (next.done) break;
      size += next.value.byteLength; if (size > 16 * 1024) { await reader.cancel(); throw new ComposerRequestError("Composer query exceeds 16 KiB.", 413); } chunks.push(next.value); }
    try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch (error) { if (error instanceof ComposerRequestError) throw error; throw new ComposerRequestError("Invalid composer query JSON."); }
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}
export class ComposerActionsHttp {
  #inFlight = 0;
  constructor(private options: {
    hostId: string; resolveCwd(target?: WorkspaceTarget): string;
    getHandle(sessionId: string): Promise<Pick<WorkerSession, "getComposerActions" | "getComposerCompletions" | "cwd">>;
    runtime: Pick<WorkerRuntime, "getComposerActions" | "getComposerCompletions">;
  }) {}
  private async readSkill(path: string): Promise<{ content: string; verify(): Promise<void> }> {
    if (!path || !path.startsWith("/") || path.includes("\0")) throw new ComposerRequestError("Native skill content is unavailable.", 404, "SKILL_UNAVAILABLE");
    let handle;
    let resolvedBefore: string;
    try { resolvedBefore = await realpath(path); handle = await open(resolvedBefore, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw new ComposerRequestError("Native skill content is unavailable.", 404, "SKILL_UNAVAILABLE"); }
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new ComposerRequestError("Native skill content is unavailable.", 404, "SKILL_UNAVAILABLE");
      if (before.size > 1024 * 1024) throw new ComposerRequestError("Native skill content is unavailable.", 413, "SKILL_TOO_LARGE");
      const data = Buffer.alloc(1024 * 1024 + 1);
      let offset = 0;
      while (offset < data.length) { const result = await handle.read(data, offset, data.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      const after = await handle.stat();
      if (offset > 1024 * 1024 || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || offset !== after.size) {
        throw new ComposerRequestError("Native skill content changed while it was read.", 409, "SKILL_CHANGED");
      }
      const resolvedAfter = await realpath(path);
      const namedAfter = await lstat(path);
      if (resolvedAfter !== resolvedBefore || (!namedAfter.isSymbolicLink() && (namedAfter.dev !== after.dev || namedAfter.ino !== after.ino))) throw new ComposerRequestError("Native skill content changed while it was read.", 409, "SKILL_CHANGED");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, offset));
      return { content, verify: async () => {
        try {
          if (await realpath(path) !== resolvedBefore) throw new Error();
          const currentHandle = await open(resolvedBefore, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let current;
          try { current = await currentHandle.stat(); } finally { await currentHandle.close(); }
          if (current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new Error();
        } catch { throw new ComposerRequestError("Native skill content changed while it was read.", 409, "SKILL_CHANGED"); }
      } };
    } catch (error) {
      if (error instanceof ComposerRequestError) throw error;
      throw new ComposerRequestError("Native skill content is unavailable.", 404, "SKILL_UNAVAILABLE");
    } finally { await handle.close(); }
  }
  private async skillDetail(input: Record<string, unknown>, target: WorkspaceTarget | undefined, cwd: string, handle: Pick<WorkerSession, "getComposerActions" | "cwd"> | undefined): Promise<ComposerSkillDetail> {
    if (typeof input.skillId !== "string" || !input.skillId || input.skillId.length > 512 || /[\0\r\n]/.test(input.skillId) || typeof input.catalogRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.catalogRevision)) throw new ComposerRequestError("Invalid native skill request.");
    const get = async () => handle ? handle.getComposerActions() : this.options.runtime.getComposerActions(cwd);
    const first = await get();
    if (first.cwd !== cwd || first.revision !== input.catalogRevision) throw new ComposerRequestError("The native composer catalog changed. Refresh before opening this skill.", 409, "COMPOSER_CATALOG_CHANGED");
    const skill = first.skills.find(item => item.id === input.skillId);
    const path = skill?.source.kind === "skill" ? skill.source.path : undefined;
    if (!path) throw new ComposerRequestError("Native skill content is unavailable.", 404, "SKILL_UNAVAILABLE");
    const read = await this.readSkill(path);
    const second = await get();
    const secondSkill = second.skills.find(item => item.id === input.skillId);
    if (second.cwd !== cwd || second.revision !== first.revision || secondSkill?.source.path !== path) throw new ComposerRequestError("The native composer catalog changed while the skill was read.", 409, "COMPOSER_CATALOG_CHANGED");
    await read.verify();
    return { protocolVersion: 1, hostId: this.options.hostId, ...(target ? { target } : {}), cwd, revision: first.revision, skillId: input.skillId, content: read.content };
  }
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    if (!["/v1/composer/actions", "/v1/composer/completions", "/v1/composer/skill-detail"].includes(url.pathname)) return undefined;
    const headers = { "Cache-Control": "no-store", [COMPOSER_OWNER_HEADER]: this.options.hostId };
    let admitted = false;
    try {
      if (request.headers.get(COMPOSER_OWNER_HEADER) !== this.options.hostId) throw new ComposerRequestError("The selected composer owner no longer matches this endpoint. Refresh hosts before retrying.", 409, "OWNER_MISMATCH");
      if (request.method !== "POST") throw new ComposerRequestError("Use POST for composer queries.", 405);
      if (this.#inFlight >= 4) throw new ComposerRequestError("This host has four active composer queries. Try again after they finish.", 429, "COMPOSER_BUSY");
      this.#inFlight++; admitted = true;
      const input = await readBody(request), completions = url.pathname.endsWith("/completions");
      const skillDetail = url.pathname.endsWith("/skill-detail");
      keys(input, skillDetail ? ["target", "skillId", "catalogRevision"] : completions ? ["target", "kind", "query", "commandName", "catalogRevision", "limit"] : ["target", "refresh"]);
      let target: WorkspaceTarget | undefined;
      try { target = input.target === undefined ? undefined : parseWorkspaceTarget(input.target); }
      catch { throw new ComposerRequestError("Select a catalogued project or session on this host."); }
      const resolve = () => { try { return this.options.resolveCwd(target); } catch { throw new ComposerRequestError("The selected composer owner no longer exists on this host.", 409, "STALE_TARGET"); } };
      const cwd = resolve();
      const handle = target && "sessionId" in target ? await this.options.getHandle(target.sessionId) : undefined;
      if (handle && handle.cwd !== cwd) throw new ComposerRequestError("The selected native workspace changed. Refresh its catalog.", 409, "STALE_TARGET");
      if (skillDetail) {
        const detail = await this.skillDetail(input, target, cwd, handle);
        if (resolve() !== cwd) throw new ComposerRequestError("The selected workspace changed while the skill was read. Refresh its catalog.", 409, "STALE_TARGET");
        if (Buffer.byteLength(JSON.stringify(detail), "utf8") > 2 * 1024 * 1024) throw new ComposerRequestError("Native skill detail exceeds 2 MiB.", 413, "SKILL_TOO_LARGE");
        return Response.json(detail, { headers });
      }
      let result;
      if (completions) {
        if (!["file", "reference", "command-argument"].includes(String(input.kind)) || typeof input.query !== "string" || input.query.length > 2048 || /[\0\r\n]/.test(input.query)
          || input.catalogRevision !== undefined && (typeof input.catalogRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.catalogRevision))
          || input.commandName !== undefined && (typeof input.commandName !== "string" || !input.commandName || input.commandName.length > 200 || /[\s\0]/.test(input.commandName))
          || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)) throw new ComposerRequestError("Invalid native completion query.");
        const query = { ...input, target } as unknown as ComposerCompletionQuery;
        // Resolve current metadata before callback dispatch, so stale callback
        // identities never execute even when its implementation has side effects.
        const catalog = handle ? await handle.getComposerActions() : await this.options.runtime.getComposerActions(cwd);
        if (query.catalogRevision && query.catalogRevision !== catalog.revision) throw new ComposerRequestError("The native composer catalog changed. Refresh before completing this input.", 409, "COMPOSER_CATALOG_CHANGED");
        result = handle ? await handle.getComposerCompletions(query) : await this.options.runtime.getComposerCompletions(cwd, query);
      } else {
        if (input.refresh !== undefined && typeof input.refresh !== "boolean") throw new ComposerRequestError("Invalid composer refresh flag.");
        result = handle ? await handle.getComposerActions() : await this.options.runtime.getComposerActions(cwd, { refresh: input.refresh as boolean | undefined });
      }
      if (resolve() !== cwd || result.cwd !== cwd) throw new ComposerRequestError("The selected workspace changed during completion. Refresh its catalog.", 409, "STALE_TARGET");
      return Response.json({ ...result, hostId: this.options.hostId, ...(target ? { target } : {}) }, { headers });
    } catch (error) {
      return Response.json({ error: { message: error instanceof Error ? error.message.slice(0, 4096) : "Native composer query failed.", code: error instanceof ComposerRequestError ? error.code : "COMPOSER_QUERY_FAILED" } }, { status: error instanceof ComposerRequestError ? error.status : 500, headers });
    } finally { if (admitted) this.#inFlight--; }
  }
}
