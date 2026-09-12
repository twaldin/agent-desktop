import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { browserAutocompleteSourceKey } from "./browser-autocomplete-records";

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const fixture=()=>{const root=realpathSync(mkdtempSync(join(tmpdir(),"browser-autocomplete-")));roots.push(root);return{root,store:new HostStore(root)}};
const target={name:"tab",targetId:"target"},owner={kind:"session" as const,id:"session"};
const observed=(nativeId:string,url="https://example.com/",current=true)=>({sourceKey:browserAutocompleteSourceKey(owner,target,nativeId),entry:{id:nativeId,url,title:"Example",current}});
test("host history persists observed OMP pages and deletion across unchanged native history",()=>{
  const f=fixture();f.store.browserAutocomplete.observe([observed("1")]);let rows=f.store.browserAutocomplete.matches("exam",()=>"opaque");
  expect(rows.map(row=>row.type)).toEqual(["history","search-what-you-typed"]);const id=rows[0]!.id.slice("history:".length);f.store.browserAutocomplete.delete(id);
  f.store.browserAutocomplete.observe([observed("1")]);expect(f.store.browserAutocomplete.matches("",()=>"opaque")).toEqual([]);
  f.store.browserAutocomplete.observe([observed("rotated-native-id")]);expect(f.store.browserAutocomplete.matches("",()=>"opaque")).toEqual([]);
  f.store.close();f.store=new HostStore(f.root);expect(f.store.browserAutocomplete.matches("",()=>"opaque")).toEqual([]);f.store.close();
});
test("explicit native revisitation revives a deleted URL while unsupported schemes never persist",()=>{
  const f=fixture();f.store.browserAutocomplete.observe([observed("1")]);const id=f.store.browserAutocomplete.matches("",()=>"opaque")[0]!.id.slice(8);f.store.browserAutocomplete.delete(id);
  f.store.browserAutocomplete.observe([observed("2")],true);expect(f.store.browserAutocomplete.matches("",()=>"opaque")).toHaveLength(1);
  f.store.browserAutocomplete.observe([{sourceKey:"data",entry:{id:"3",url:"data:text/html,secret",title:"Secret",current:true}}]);expect(f.store.browserAutocomplete.matches("",()=>"opaque")).toHaveLength(1);f.store.close();
});
