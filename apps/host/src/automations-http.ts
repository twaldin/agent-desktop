import { AUTOMATIONS_OWNER_HEADER, parseAutomationMutation, parseAutomationsQuery } from "../../../packages/shared/src/automations";
import { AutomationHttpError, AutomationService } from "./automations";

const REQUEST_LIMIT = 256 * 1024;
async function readMutation(request: Request): Promise<unknown> {
  if (!request.body) throw new AutomationHttpError(400, "An automation mutation body is required.");
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,expired=false;
  const timer=setTimeout(()=>{expired=true;void reader.cancel();},5_000);
  try {
    for(;;){const part=await reader.read();if(expired)throw new AutomationHttpError(408,"The automation request body timed out.");if(part.done)break;
      bytes+=part.value.byteLength;if(bytes>REQUEST_LIMIT)throw new AutomationHttpError(413,"The automation request exceeds 256 KiB.");chunks.push(part.value);}
    return JSON.parse(Buffer.concat(chunks,bytes).toString("utf8"));
  } catch(error) { await reader.cancel().catch(()=>{}); throw error; }
  finally { clearTimeout(timer);reader.releaseLock(); }
}

export class AutomationsHttp {
  constructor(private readonly hostId: string, private readonly service: AutomationService) {}

  async route(request: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname !== "/v1/automations") return undefined;
    const headers = { "Cache-Control": "no-store", [AUTOMATIONS_OWNER_HEADER]: this.hostId };
    if (request.headers.get(AUTOMATIONS_OWNER_HEADER) !== this.hostId)
      return Response.json({ error: { code: "OWNER_MISMATCH", message: "The automation owner changed." } }, { status: 409, headers });
    try {
      if (request.method === "GET") {
        return Response.json(this.service.snapshot(parseAutomationsQuery({
          ...(url.searchParams.has("automationId") ? { automationId: url.searchParams.get("automationId") } : {}),
          ...(url.searchParams.has("before") ? { before: url.searchParams.get("before") } : {}),
        })), { headers });
      }
      if (request.method !== "POST")
        return Response.json({ error: { code: "INVALID_REQUEST", message: "Use GET or POST for automations." } }, { status: 405, headers });
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > REQUEST_LIMIT) throw new AutomationHttpError(413, "The automation request exceeds 256 KiB.");
      return Response.json(await this.service.mutate(parseAutomationMutation(await readMutation(request))), { headers });
    } catch (error) {
      const status = error instanceof AutomationHttpError ? error.status : 400;
      const message = error instanceof Error ? error.message : "The automation request failed.";
      return Response.json({ error: { code: status === 409 ? "CONFLICT" : status === 413 ? "TOO_LARGE" : "INVALID_REQUEST", message } }, { status, headers });
    }
  }
}
