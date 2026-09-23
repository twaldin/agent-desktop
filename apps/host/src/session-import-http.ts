import { MAX_SESSION_IMPORT_REPLY_BYTES, SESSION_IMPORT_OWNER_HEADER, nativeImportCandidateId, nativeImportCommandId, parseNativeImportInspection, parseNativeImportListing,
  parseNativeImportAdmissionRequest,parseNativeImportPreparationRequest,parseNativeImportPreparation,parseNativeImportOutcome } from "../../../packages/shared/src/session-import";
import type { NativeSessionImportDiscovery } from "./omp-import/discovery";
import type { SessionImportActions } from "./session-import-actions";

async function readImportBody(request:Request):Promise<unknown>{
  const reader=request.body?.getReader();if(!reader)throw new Error("Missing native import request.");
  const chunks:Uint8Array[]=[];let size=0,expired=false;
  const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},5000);
  try{for(;;){const part=await reader.read();if(expired)throw new Error("Native import request timed out.");if(part.done)break;size+=part.value.byteLength;if(size>4096)throw new Error("Native import request exceeds its bound.");chunks.push(part.value);}
    return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(Buffer.concat(chunks,size)));
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{clearTimeout(timer);reader.releaseLock();}
}

/** Registered behind the host's authenticated-device boundary. Candidate IDs
 * resolve only inside the owning profile; no renderer path opens a native file. */
export class SessionImportHttp {
  private closing = false;
  private pending = new Set<Promise<Response>>();
  constructor(private readonly hostId: string, private readonly discovery: Pick<NativeSessionImportDiscovery, "scan" | "inspect">,
    private readonly actions?: Pick<SessionImportActions,"prepare"|"admit"|"status"|"dispose">) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const action=/^\/v1\/session-imports\/(prepare|admit|outcomes\/([^/]+))$/.exec(url.pathname);
    const match = /^\/v1\/session-imports(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match&&!action) return;
    const headers = { [SESSION_IMPORT_OWNER_HEADER]: this.hostId, "Cache-Control": "no-store" };
    const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
    if (request.headers.get(SESSION_IMPORT_OWNER_HEADER) !== this.hostId) return fail(409, "IMPORT_OWNER_CHANGED", "The original native session belongs to another host.");
    if (request.method !== (action&&!action[2]?"POST":"GET") || url.search) return fail(405, "IMPORT_METHOD_REQUIRED", "Use the original native session request method.");
    if (this.closing) return fail(503, "IMPORT_STOPPING", "The owning host is stopping.");
    if (this.pending.size >= 4) return fail(429, "IMPORT_BUSY", "Native session inspection is busy. Try again shortly.");
    let candidateId: string | undefined;
    try { if (!action&&match?.[1]) candidateId = nativeImportCandidateId(decodeURIComponent(match[1]));if(action?.[2])nativeImportCommandId(decodeURIComponent(action[2])); }
    catch { return fail(400, "IMPORT_INVALID_CANDIDATE", "Select an original native session from this host."); }
    const read = Promise.resolve().then(async () => {
      try {
        request.signal.throwIfAborted();
        if(action){
          if(!this.actions)return fail(409,"IMPORT_ADMISSION_UNAVAILABLE","This host cannot yet acquire ownership of an original native session.");
          let value:unknown;
          if(action[2]){
            const commandId=nativeImportCommandId(decodeURIComponent(action[2]));
            value=parseNativeImportOutcome(await this.actions.status(commandId),this.hostId,commandId);
          }else if(action[1]==="prepare"){
            const input=parseNativeImportPreparationRequest(await readImportBody(request));request.signal.throwIfAborted();
            if(this.closing)return fail(503,"IMPORT_STOPPING","The owning host is stopping.");
            value=parseNativeImportPreparation(await this.actions.prepare(input.candidateId,input.revision),this.hostId,input.candidateId,input.revision);
          }else{
            const input=parseNativeImportAdmissionRequest(await readImportBody(request));request.signal.throwIfAborted();
            if(this.closing)return fail(503,"IMPORT_STOPPING","The owning host stopped before import dispatch.");
            // Once dispatched, client cancellation is not permission to abandon
            // publication or replay the native operation. The drain joins it.
            value=parseNativeImportOutcome(await this.actions.admit(input.commandId,input.preparationId),this.hostId,input.commandId);
          }
          return Response.json(value,{headers});
        }
        const value = candidateId === undefined
          ? parseNativeImportListing({ version: 1, hostId: this.hostId, candidates: await this.discovery.scan(request.signal) }, this.hostId)
          : parseNativeImportInspection({ version: 1, hostId: this.hostId, inspection: await this.discovery.inspect(candidateId) }, this.hostId, candidateId);
        request.signal.throwIfAborted();
        if (this.closing) return fail(503, "IMPORT_STOPPING", "The owning host stopped this inspection.");
        const body = new TextEncoder().encode(JSON.stringify(value));
        if (body.byteLength > MAX_SESSION_IMPORT_REPLY_BYTES) return fail(413, "IMPORT_REPLY_LIMIT", "Native session inspection exceeds its reply limit; no partial result was returned.");
        return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
      } catch (error) {
        return fail(request.signal.aborted ? 499 : 409, request.signal.aborted ? "IMPORT_CANCELLED" : "IMPORT_SOURCE_UNAVAILABLE",
          request.signal.aborted ? "The native session inspection was cancelled." : error instanceof Error ? error.message : "The original native session could not be inspected.");
      }
    });
    this.pending.add(read);
    try { return await read; } finally { this.pending.delete(read); }
  }
  async dispose(): Promise<void> { this.closing = true; await Promise.allSettled([...this.pending,this.actions?.dispose()]); }
}
