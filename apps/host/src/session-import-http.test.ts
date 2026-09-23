import { expect, test } from "bun:test";
import { SessionImportHttp } from "./session-import-http";
const request = (suffix = "", extra: RequestInit = {}) => new Request("http://owner/v1/session-imports" + suffix, { headers: { "X-Agent-Host-Id": "owner" }, ...extra });
const candidate = { candidateId: "original", sourcePath: "/profile/project/original.jsonl", nativeId: "session", title: "Original", persistedStatus: "pending" as const };
const inspection = { candidateId: "original", revision: "revision", originalFile: candidate.sourcePath, nativeId: "session", entries: 3, messages: 1, malformedRecords: 0, issues: [], writeAdmission: { allowed: false as const, reason: "ownership-unverified" as const } };
test("owner-bound explicit scan and inspection never grant writable admission", async () => {
  const calls: string[] = [];
  const route = new SessionImportHttp("owner", { scan: async () => { calls.push("scan"); return [candidate]; }, inspect: async id => { calls.push(id); return inspection; } });
  expect(await (await route.route(request()))!.json()).toEqual({ version: 1, hostId: "owner", candidates: [candidate] });
  expect(await (await route.route(request("/original")))!.json()).toEqual({ version: 1, hostId: "owner", inspection });
  expect(calls).toEqual(["scan", "original"]);
  for (const req of [request("", { method: "POST" }), request("?path=/foreign"), request("/%2Foutside"), request("", { headers: { "X-Agent-Host-Id": "other" } })]) {
    expect((await route.route(req))!.status).toBeGreaterThanOrEqual(400);
  }
  expect(calls).toEqual(["scan", "original"]); await route.dispose();
});
test("disposal joins already admitted reads and bars new reads, even before their first microtask", async () => {
  let release!: (value: typeof inspection) => void; let calls = 0;
  const held = new Promise<typeof inspection>(resolve => { release = resolve; });
  const route = new SessionImportHttp("owner", { scan: async () => [], inspect: async () => { calls++; return held; } });
  const read = route.route(request("/original")); let drained = false; const closing = route.dispose().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false); expect(calls).toBe(1);
  expect((await route.route(request()))!.status).toBe(503);
  release(inspection); expect((await read)!.status).toBe(503); await closing; expect(drained).toBe(true);
});
test("four pending reads bound admission; cancelled and wrong-candidate results are not published", async () => {
  let release!: (value: typeof inspection) => void; const held = new Promise<typeof inspection>(resolve => { release = resolve; });
  const route = new SessionImportHttp("owner", { scan: async () => [], inspect: async () => held });
  const controller = new AbortController();
  const reads = [route.route(request("/original", { signal: controller.signal })), ...Array.from({ length: 3 }, () => route.route(request("/original")))];
  expect((await route.route(request("/original")))!.status).toBe(429); controller.abort(); release(inspection);
  expect((await reads[0])!.status).toBe(499); await Promise.all(reads); await route.dispose();
  const wrong = new SessionImportHttp("owner", { scan: async () => [], inspect: async () => ({ ...inspection, candidateId: "replacement" }) });
  expect((await wrong.route(request("/original")))!.status).toBe(409); await wrong.dispose();
});
test("explicit admission binds its parsed command and drains after caller cancellation; malformed input never reaches the owner",async()=>{
  let resolve!:()=>void;const gate=new Promise<void>(r=>resolve=r);const calls:unknown[]=[];
  const route=new SessionImportHttp("owner",{scan:async()=>[],inspect:async()=>inspection},{
    prepare:async(candidateId,revision)=>({version:1,hostId:"owner",candidateId,revision,state:"refused",reason:"not-participating",message:"Original writer does not participate"}),
    admit:async(commandId,preparationId)=>{calls.push({commandId,preparationId});await gate;return{version:1,hostId:"owner",commandId,state:"imported",original:{sessionId:"native",originalFile:"/original",cwd:"/project"}}},
    status:async commandId=>({version:1,hostId:"owner",commandId,state:"pending"}),dispose:async()=>{},
  });
  const post=(suffix:string,value:unknown,signal?:AbortSignal)=>request(suffix,{method:"POST",headers:{"X-Agent-Host-Id":"owner","Content-Type":"application/json"},body:JSON.stringify(value),signal});
  expect((await route.route(post("/admit",{commandId:"command",preparationId:"prepared",path:"/unselected"})))!.status).toBe(409);expect(calls).toEqual([]);
  expect(await (await route.route(post("/prepare",{candidateId:"original",revision:"revision"})))!.json()).toMatchObject({state:"refused",reason:"not-participating"});
  const controller=new AbortController(),read=route.route(post("/admit",{commandId:"command",preparationId:"prepared"},controller.signal));
  for(let n=0;n<20&&!calls.length;n++)await Promise.resolve();expect(calls).toEqual([{commandId:"command",preparationId:"prepared"}]);
  controller.abort();let closed=false;const closing=route.dispose().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);
  resolve();expect(await (await read)!.json()).toMatchObject({commandId:"command",state:"imported"});await closing;expect(closed).toBe(true);
});
