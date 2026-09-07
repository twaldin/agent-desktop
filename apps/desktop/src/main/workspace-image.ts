import { extname, isAbsolute } from "node:path";
import type { WorkspaceQueryResult, WorkspaceTarget } from "@agent-desktop/shared";
import type { WorkspaceCopySource } from "./workspace-save-copy";

const CHUNK_BYTES = 1024 * 1024;
const MIME = new Map([
  [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"], [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
]);
type Info = Extract<WorkspaceQueryResult, {type: "file.copy-info"}>;
type Chunk = Extract<WorkspaceQueryResult, {type: "file.copy-chunk"}>;
type Grant = { senderId: number; path: string; mime: string; source(signal: AbortSignal): WorkspaceCopySource; active: Set<AbortController> };

function validateOwner(target: WorkspaceTarget, path: string, hostId: string): void {
  if (!target || typeof target !== "object" || Object.keys(target).length !== 1 || !("projectId" in target || "sessionId" in target)
    || typeof Object.values(target)[0] !== "string" || !Object.values(target)[0] || Object.values(target)[0].length > 200) throw new Error("Select one workspace image owner.");
  if (typeof hostId !== "string" || !hostId || hostId.length > 200) throw new Error("Select the workspace image host.");
  if (typeof path !== "string" || !path || path.length > 16_384 || path.includes("\0") || path.includes("\\") || isAbsolute(path) || path.split("/").includes("..")) throw new Error("Select a relative image path in the owning workspace.");
}
function info(value: WorkspaceQueryResult, path: string): Info {
  if (value.type !== "file.copy-info" || value.path !== path || !Number.isSafeInteger(value.size) || value.size < 0
    || typeof value.absolutePath !== "string" || !isAbsolute(value.absolutePath) || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error("The host returned invalid workspace image metadata.");
  return value;
}
function chunk(value: WorkspaceQueryResult, expected: Info, offset: number): Uint8Array {
  if (value.type !== "file.copy-chunk" || value.path !== expected.path || value.revision !== expected.revision || value.size !== expected.size
    || value.offset !== offset || typeof value.dataBase64 !== "string") throw new Error("The host returned a different workspace image chunk.");
  const bytes = Buffer.from(value.dataBase64, "base64"), length = Math.min(CHUNK_BYTES, expected.size - offset);
  if (bytes.length !== length || bytes.toString("base64") !== value.dataBase64) throw new Error("The host returned an incomplete workspace image chunk.");
  return bytes;
}

/** Opaque renderer grants keep endpoint credentials and machine paths out of URLs. */
export class WorkspaceImageGrants {
  private grants = new Map<string, Grant>();

  acquire(input: { senderId: number; target: WorkspaceTarget; path: string; hostId: string; source(signal: AbortSignal): WorkspaceCopySource }): {url: string; id: string} {
    validateOwner(input.target, input.path, input.hostId);
    const mime = MIME.get(extname(input.path).toLowerCase()) ?? "application/octet-stream";
    const id = crypto.randomUUID();
    this.grants.set(id, { senderId: input.senderId, path: input.path, mime, source: input.source, active: new Set() });
    return { id, url: `agent-workspace-image://image/${id}` };
  }

  release(id: string, senderId: number): boolean {
    const grant = this.grants.get(id);
    if (!grant || grant.senderId !== senderId) return false;
    this.grants.delete(id);
    for (const active of grant.active) active.abort(new Error("The workspace image grant was released."));
    grant.active.clear();
    return true;
  }

  releaseSender(senderId: number): void {
    for (const [id, grant] of this.grants) if (grant.senderId === senderId) this.release(id, senderId);
  }

  async response(url: string, requestSignal?: AbortSignal): Promise<Response> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return new Response("Invalid workspace image URL.", {status: 400}); }
    const id = parsed.protocol === "agent-workspace-image:" && parsed.hostname === "image" && !parsed.username && !parsed.password && !parsed.port
      && /^\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed.pathname) ? parsed.pathname.slice(1) : undefined;
    const grant = id ? this.grants.get(id) : undefined;
    if (!grant || parsed.search || parsed.hash || parsed.href !== `agent-workspace-image://image/${id}`) return new Response("Workspace image grant not found.", {status: 404});
    const active = new AbortController(); grant.active.add(active);
    const abort = () => active.abort(requestSignal?.reason);
    if (requestSignal?.aborted) abort(); else requestSignal?.addEventListener("abort", abort, {once: true});
    let initial: Info;
    let source: WorkspaceCopySource;
    try {
      source = grant.source(active.signal);
      initial = info(await source.query({type: "file.copy-info", path: grant.path}), grant.path);
      active.signal.throwIfAborted();
    }
    catch (error) { grant.active.delete(active); requestSignal?.removeEventListener("abort", abort); throw error; }
    let offset = 0, finished = false;
    const cleanup = () => { if (finished) return; finished = true; grant.active.delete(active); requestSignal?.removeEventListener("abort", abort); };
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          active.signal.throwIfAborted();
          if (offset < initial.size) {
            const bytes = chunk(await source.query({type: "file.copy-chunk", path: grant.path, revision: initial.revision, offset}), initial, offset);
            active.signal.throwIfAborted();
            const nextOffset = offset + bytes.length;
            if (nextOffset === initial.size) {
              const final = info(await source.query({type: "file.copy-info", path: grant.path}), grant.path);
              active.signal.throwIfAborted();
              if (final.revision !== initial.revision || final.size !== initial.size || final.absolutePath !== initial.absolutePath) throw new Error("The workspace image changed while it was loading.");
              offset = nextOffset; controller.enqueue(bytes); cleanup(); controller.close(); return;
            }
            offset = nextOffset; controller.enqueue(bytes); return;
          }
          const final = info(await source.query({type: "file.copy-info", path: grant.path}), grant.path);
          active.signal.throwIfAborted();
          if (final.revision !== initial.revision || final.size !== initial.size || final.absolutePath !== initial.absolutePath) throw new Error("The workspace image changed while it was loading.");
          cleanup(); controller.close();
        } catch (error) { cleanup(); controller.error(error); }
      },
      cancel(reason) { active.abort(reason); cleanup(); },
    }), {headers: {"Content-Type": grant.mime, "Content-Length": String(initial.size), "Cache-Control": "no-store"}});
  }
}
