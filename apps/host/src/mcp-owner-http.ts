import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseMcpOwnerRequest, SESSION_MCP_OWNER_HEADER, type McpOwnerRequest, type McpOwnerSnapshot } from "@agent-desktop/shared";
import type { HostStore } from "./store";
import type { WorkerMcpOwner, WorkerRuntime } from "./omp-workers/runtime";
import { readMcpAppBody } from "./session-mcp-app-http";
interface Owner {
  id: string;
  projectId: string | null;
  originalPath: string;
  cwd: string;
  device: bigint;
  inode: bigint;
  input: string;
  abort: AbortController;
  ready: Promise<WorkerMcpOwner>;
  handle?: WorkerMcpOwner;
  closing?: Promise<void>;
}
/** Authenticated callers acquire a directory-owned native context explicitly.
 * Read/app/answer never allocate one, and a retired ID can never be reused. */
export class McpOwnerHttp {
  readonly #epoch = crypto.randomUUID();
  readonly #owners = new Map<string, Owner>();
  readonly #retired = new Map<string, string>();
  readonly #requests = new Set<Promise<unknown>>();
  #disposal?: Promise<void>;
  constructor(private readonly store: HostStore, private readonly defaultDirectory: string, private readonly runtime: Pick<WorkerRuntime, "createMcpOwner">) {}
  #path(projectId: string | null): string {
    if (projectId === null) return resolve(this.defaultDirectory);
    const project = this.store.getProject(projectId);
    if (!project || project.hostId !== this.store.host.id || !isAbsolute(project.path)) throw new Error("The MCP project belongs to another host.");
    return project.path;
  }
  #current(owner: Owner): void {
    if (this.#disposal || owner.closing || owner.abort.signal.aborted) throw new Error("The original MCP owner is retired.");
    try {
      const source = this.#path(owner.projectId), cwd = realpathSync(source), info = statSync(cwd, { bigint: true });
      if (source !== owner.originalPath || cwd !== owner.cwd || info.dev !== owner.device || info.ino !== owner.inode || !info.isDirectory()) throw new Error("The original MCP owner directory changed.");
      if (owner.handle?.workerFailure) throw new Error("The original MCP worker stopped. Acquire another owner deliberately.");
    } catch (error) { owner.abort.abort(error); void this.#close(owner).catch(() => {}); throw error; }
  }
  #acquire(request: Extract<McpOwnerRequest, { target: unknown }>): Owner {
    if (this.#disposal) throw new Error("MCP owners are stopping.");
    if (this.#retired.has(request.ownerId)) throw new Error("This MCP acquisition was already retired.");
    const input = JSON.stringify(request.target), existing = this.#owners.get(request.ownerId);
    if (existing) {
      if (existing.input !== input) throw new Error("MCP owner ID was reused with different input.");
      this.#current(existing); return existing;
    }
    if (this.#owners.size + this.#retired.size >= 4096 || [...this.#owners.values()].filter(value => !value.closing).length >= 8) throw new Error("Close an existing MCP owner before connecting another.");
    const originalPath = this.#path(request.target.projectId), cwd = realpathSync(originalPath), info = statSync(cwd, { bigint: true });
    if (!info.isDirectory() || request.target.projectId !== null && originalPath !== cwd || request.target.expectedDirectory !== undefined && request.target.expectedDirectory !== cwd) throw new Error("The requested MCP owner directory changed.");
    const owner = { id: request.ownerId, projectId: request.target.projectId, originalPath, cwd, device: info.dev, inode: info.ino, input, abort: new AbortController() } as Owner;
    this.#owners.set(owner.id, owner);
    // Reserve before child callbacks, and retain the original acquisition for close.
    owner.ready = Promise.resolve().then(async () => {
      this.#current(owner);
      const handle = await this.runtime.createMcpOwner({ id: owner.id, cwd }, { signal: owner.abort.signal });
      owner.handle = handle;
      this.#current(owner); return handle;
    });
    void owner.ready.catch(() => {});
    return owner;
  }
  #close(owner: Owner): Promise<void> {
    if (owner.closing) return owner.closing;
    owner.abort.abort(new Error("The MCP owner is retired."));
    owner.closing = Promise.resolve().then(async () => {
      await owner.ready.catch(() => {});
      await owner.handle?.dispose();
    });
    void owner.closing.catch(() => {});
    return owner.closing;
  }
  async #snapshot(owner: Owner): Promise<McpOwnerSnapshot> {
    const handle = await owner.ready; this.#current(owner);
    const [catalogue, interactions] = await Promise.all([handle.read(), handle.interactions()]);
    this.#current(owner);
    return { ownerId: owner.id, epoch: this.#epoch, cwd: owner.cwd, projectId: owner.projectId, catalogue, interactions };
  }
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    if (url.pathname !== "/v1/mcp-owners") return;
    const headers = { "Cache-Control": "no-store", [SESSION_MCP_OWNER_HEADER]: this.store.host.id };
    const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_MCP_OWNER_HEADER) !== this.store.host.id) return fail(409, "OWNER_MISMATCH", "The MCP owner belongs to another host.");
    if (request.method !== "POST") return fail(405, "INVALID_MCP_OWNER", "Use POST for this operation.");
    let input: McpOwnerRequest;
    try { input = parseMcpOwnerRequest(await readMcpAppBody(request)); }
    catch { return fail(400, "INVALID_MCP_OWNER", "Invalid MCP owner request."); }
    if (this.#disposal) return fail(503, "HOST_STOPPING", "MCP owners are stopping.");
    const operation = (async () => {
      try {
        if (input.type !== "acquire" && input.type !== "retire" && input.epoch !== this.#epoch) throw new Error("The original MCP host lifetime ended. No operation was replayed.");
        if (input.type === "retire") {
          const fingerprint = JSON.stringify(input.target), owner = this.#owners.get(input.ownerId), previous = this.#retired.get(input.ownerId);
          if (owner && owner.input !== fingerprint || previous !== undefined && previous !== fingerprint) throw new Error("MCP retirement belongs to another acquisition.");
          if (!owner && previous === undefined && this.#owners.size + this.#retired.size >= 4096) throw new Error("MCP retirement limit exceeded.");
          this.#retired.set(input.ownerId, fingerprint);
          if (owner) await this.#close(owner);
          return Response.json({ protocolVersion: 1, hostId: this.store.host.id, ownerId: input.ownerId, value: { closed: true } }, { headers });
        }
        const owner = input.type === "acquire" ? this.#acquire(input) : this.#owners.get(input.ownerId);
        if (!owner) throw new Error("The original MCP owner is unavailable. This operation cannot acquire a replacement.");
        let value: unknown;
        if (input.type === "close") { await this.#close(owner); value = { closed: true }; }
        else {
          const handle = await owner.ready; this.#current(owner);
          if (input.type === "app") { value = await handle.request(input.request); this.#current(owner); }
          else {
            if (input.type === "answer") { await handle.respond(input.interactionId, input.response); this.#current(owner); }
            value = await this.#snapshot(owner);
          }
        }
        return Response.json({ protocolVersion: 1, hostId: this.store.host.id, ownerId: owner.id, value }, { headers });
      } catch (error) { return fail(503, "MCP_OWNER_UNAVAILABLE", error instanceof Error ? error.message : "The original MCP operation could not be confirmed."); }
    })();
    this.#requests.add(operation);
    try { return await operation; } finally { this.#requests.delete(operation); }
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposal = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...this.#owners.values()].map(owner => this.#close(owner)));
      await Promise.allSettled([...this.#requests]);
      const errors = results.flatMap(value => value.status === "rejected" ? [value.reason] : []);
      if (errors.length) throw new AggregateError(errors, "MCP owner cleanup failed.");
    });
    return this.#disposal;
  }
}
