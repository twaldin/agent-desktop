import { expect, test } from "bun:test";
import { requestNativeImportInspection, requestNativeImportListing, requestNativeImportPreparation, requestNativeImportAdmission, requestNativeImportStatus } from "./session-import-transport";
import { MAX_SESSION_IMPORT_REPLY_BYTES } from "@agent-desktop/shared";
test("real loopback transport binds host and opaque original, forbids redirects and cancels bounded errors", async () => {
  const seen: string[] = []; let mode = "list";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    seen.push(new URL(request.url).pathname);
    expect(request.headers.get("Authorization")).toBe("Bearer fixture"); expect(request.headers.get("X-Agent-Host-Id")).toBe("host");
    if (mode === "redirect") return Response.redirect("http://127.0.0.1:1/foreign");
    if (mode === "oversized") return new Response(" ".repeat(MAX_SESSION_IMPORT_REPLY_BYTES + 1), { headers: { "X-Agent-Host-Id": "host" } });
    if (mode === "old") return Response.json({ error: "Not found" }, { status: 404 });
    if (mode === "foreign") return Response.json({}, { headers: { "X-Agent-Host-Id": "other" } });
    if (mode === "wrong") return Response.json({ version: 1, hostId: "host", inspection: { candidateId: "replacement" } }, { headers: { "X-Agent-Host-Id": "host" } });
    return Response.json({ version: 1, hostId: "host", candidates: [] }, { headers: { "X-Agent-Host-Id": "host" } });
  } });
  const endpoint = { origin: server.url.origin, hostId: "host", token: "fixture" }, signal = new AbortController().signal;
  try {
    expect(await requestNativeImportListing(endpoint, signal)).toEqual({ version: 1, hostId: "host", candidates: [] });
    mode = "wrong"; await expect(requestNativeImportInspection(endpoint, "original", signal)).rejects.toThrow("candidate"); expect(seen.at(-1)).toBe("/v1/session-imports/original");
    mode = "foreign"; await expect(requestNativeImportListing(endpoint, signal)).rejects.toThrow("different host");
    mode = "oversized"; await expect(requestNativeImportListing(endpoint, signal)).rejects.toThrow("limit");
    mode = "redirect"; await expect(requestNativeImportListing(endpoint, signal)).rejects.toThrow();
    mode = "old"; await expect(requestNativeImportListing(endpoint, signal)).rejects.toThrow("Update the owning host");
    const count = seen.length; await expect(requestNativeImportInspection(endpoint, "/outside", signal)).rejects.toThrow("candidate"); expect(seen).toHaveLength(count);
  } finally { await server.stop(true); }
});

test("prepare, admit and recovery cross the real HTTP boundary with exact command and owner", async () => {
  const seen:Array<{method:string;path:string;body:unknown}>=[];
  const original={sessionId:"native",originalFile:"/original",cwd:"/project"};
  let wrongCommand=false;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const path=new URL(request.url).pathname,body=request.method==="POST"?await request.json():null;
    seen.push({method:request.method,path,body});
    expect(request.headers.get("Authorization")).toBe("Bearer fixture");
    expect(request.headers.get("X-Agent-Host-Id")).toBe("host");
    const value=path.endsWith("/prepare")
      ?{version:1,hostId:"host",candidateId:"candidate",revision:"revision",state:"ready",preparationId:"prepared",original}
      :{version:1,hostId:"host",commandId:wrongCommand?"replacement":"command",state:"imported",original};
    return Response.json(value,{headers:{"X-Agent-Host-Id":"host"}});
  }});
  const endpoint={origin:server.url.origin,hostId:"host",token:"fixture"},signal=new AbortController().signal;
  try {
    const prepared=await requestNativeImportPreparation(endpoint,{candidateId:"candidate",revision:"revision"},signal);
    expect(prepared.state).toBe("ready");
    const admitted=await requestNativeImportAdmission(endpoint,{commandId:"command",preparationId:"prepared"},signal);
    expect(admitted).toMatchObject({state:"imported",original});
    expect(await requestNativeImportStatus(endpoint,"command",signal)).toEqual(admitted);
    expect(seen).toEqual([
      {method:"POST",path:"/v1/session-imports/prepare",body:{candidateId:"candidate",revision:"revision"}},
      {method:"POST",path:"/v1/session-imports/admit",body:{commandId:"command",preparationId:"prepared"}},
      {method:"GET",path:"/v1/session-imports/outcomes/command",body:null},
    ]);
    wrongCommand=true;
    await expect(requestNativeImportAdmission(endpoint,{commandId:"command",preparationId:"prepared"},signal)).rejects.toThrow("another command");
    await expect(requestNativeImportStatus(endpoint,"command",signal)).rejects.toThrow("another command");
    const count=seen.length;
    await expect(requestNativeImportAdmission(endpoint,{commandId:"command",preparationId:"prepared",originalFile:"/injected"},signal)).rejects.toThrow("Unexpected");
    expect(seen).toHaveLength(count);
  } finally {await server.stop(true);}
});
