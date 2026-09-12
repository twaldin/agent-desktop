import { expect, test } from "bun:test";
import { BROWSER_AUTOCOMPLETE_OWNER_HEADER, parseBrowserAutocompleteResult, type BrowserAutocompleteRequest } from "@agent-desktop/shared";
import { BrowserAutocompleteHttp } from "./browser-autocomplete-http";
import { BrowserAutocompleteRecords } from "./browser-autocomplete-records";
import { BrowserAutocompleteService } from "./browser-autocomplete-service";

const target={workerPid:42,name:"tab",targetId:"target"};
const input:BrowserAutocompleteRequest={action:"start",editingSessionId:"edit",requestId:"request",target,query:"exam",cursorPosition:4,preventInlineAutocomplete:false};
const fixture=()=>{let saved:unknown,current=true;const service=new BrowserAutocompleteService("host",new BrowserAutocompleteRecords(()=>saved,value=>{saved=value}));
  const handle={workerPid:42,getBrowserHistory:async()=>[{id:"1",url:"https://example.com/",title:"Example",current:true}]};
  const endpoint=new BrowserAutocompleteHttp({hostId:"host",service,sessionExists:id=>current&&id==="session",getExistingHandle:async()=>current?handle:undefined});
  return{endpoint,handle,retire:()=>{current=false}}};
const request=(body:unknown=input,host="host")=>new Request("http://fixture/v1/sessions/session/browser-autocomplete",{method:"POST",headers:{"Content-Type":"application/json",[BROWSER_AUTOCOMPLETE_OWNER_HEADER]:host},body:JSON.stringify(body)});
test("authenticated session route returns exact source-bound native matches",async()=>{const f=fixture(),response=await f.endpoint.route(request());expect(response?.status).toBe(200);expect(response?.headers.get(BROWSER_AUTOCOMPLETE_OWNER_HEADER)).toBe("host");
  const result=parseBrowserAutocompleteResult(await response!.json(),"host",{kind:"session",id:"session"},input);expect(result.matches?.map(row=>row.type)).toEqual(["history","search-what-you-typed"]);await f.endpoint.dispose();});
test("route refuses foreign owner malformed bodies and owner retirement after native read",async()=>{const f=fixture();expect((await f.endpoint.route(request(input,"other")))?.status).toBe(409);expect((await f.endpoint.route(request({...input,extra:true})))?.status).toBe(400);
  const gate=Promise.withResolvers<any[]>();f.handle.getBrowserHistory=()=>gate.promise;const pending=f.endpoint.route(request());f.retire();gate.resolve([]);expect((await pending)?.status).toBe(409);await f.endpoint.dispose();});
test("shutdown drains an admitted autocomplete read and refuses its late result",async()=>{const f=fixture(),gate=Promise.withResolvers<any[]>();f.handle.getBrowserHistory=()=>gate.promise;const pending=f.endpoint.route(request()),closing=f.endpoint.dispose();
  expect(await Promise.race([closing.then(()=>"closed"),Promise.resolve("pending")])).toBe("pending");gate.resolve([]);expect((await pending)?.status).toBe(503);await closing;});
