import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOMATIONS_OWNER_HEADER } from "../../../packages/shared/src/automations";
import { HostStore } from "./store";
import { AutomationService } from "./automations";
import { AutomationsHttp } from "./automations-http";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "automations-http-")), store = new HostStore(root);
  const service = new AutomationService({ records: store.automations, dispatch: async envelope => ({ ok: false, commandId: envelope.id, error: { code: "UNUSED", message: "unused" } }),
    waitForPrompt: async () => "unknown", sessionState: async () => ({session:undefined,busy:false,hasDraft:false,hasInteraction:false}), changed: () => {} });
  cleanup.push(() => { store.close(); rmSync(root, {recursive:true,force:true}); }, () => service.dispose());
  return { store, http: new AutomationsHttp(store.host.id, service) };
}

test("automation HTTP requires the exact owner and returns bounded authoritative state", async () => {
  const {store,http}=fixture(), url=new URL("http://host/v1/automations");
  const wrong=await http.route(new Request(url,{headers:{[AUTOMATIONS_OWNER_HEADER]:"other"}}),url);
  expect(wrong?.status).toBe(409);
  const result=await http.route(new Request(url,{headers:{[AUTOMATIONS_OWNER_HEADER]:store.host.id}}),url);
  expect(result?.status).toBe(200);expect(result?.headers.get(AUTOMATIONS_OWNER_HEADER)).toBe(store.host.id);
  expect(await result?.json()).toEqual({hostId:store.host.id,tasks:[],runs:[],nextRunCursor:null});
});

test("automation HTTP rejects oversized mutation bodies before parsing",async()=>{const{store,http}=fixture(),url=new URL("http://host/v1/automations");const result=await http.route(new Request(url,{method:"POST",headers:{[AUTOMATIONS_OWNER_HEADER]:store.host.id},body:"x".repeat(256*1024+1)}),url);expect(result?.status).toBe(413);});

test("chunked bodies are cancelled at the admitted-byte bound",async()=>{const{store,http}=fixture(),url=new URL("http://host/v1/automations");let cancelled=false,pulls=0;const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(70*1024));},cancel(){cancelled=true;}});const result=await http.route(new Request(url,{method:"POST",headers:{[AUTOMATIONS_OWNER_HEADER]:store.host.id},body,duplex:"half"}as RequestInit),url);expect(result?.status).toBe(413);expect(cancelled).toBe(true);expect(pulls).toBeLessThanOrEqual(5);});
