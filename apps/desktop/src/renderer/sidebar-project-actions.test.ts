import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Project } from "../../../../packages/shared/src/protocol";
const source=readFileSync(new URL('./App.tsx',import.meta.url),'utf8');
const start=source.indexOf('  function currentSidebarProject('),end=source.indexOf('  async function archiveSidebarSession(',start);
if(start<0||end<0)throw Error('Actual App project callbacks not found');
const body=new Bun.Transpiler({loader:'tsx'}).transformSync(source.slice(start,end));
function fixture(){
 const original={hostId:'remote',id:'same-project',path:'/original',name:'Original'} as Project;
 const calls:unknown[]=[],refreshes:string[]=[],reveals:unknown[]=[];
 const records=new Map([['remote',{connected:true,state:{projects:[{...original}]}}],['selected',{connected:true,state:{projects:[{...original,hostId:'selected',path:'/unrelated'}]}}]]);
 let error:string|undefined;
 const bridge={command:async(envelope:unknown,hostId:string)=>{calls.push({envelope,hostId});return error?{ok:false,error:{message:error}}:{ok:true,value:{...original}};},revealProjectDirectory:async(...args:unknown[])=>{reveals.push(args);}};
 const desktop={localHostId:'selected',catalog:{records,refreshHost:async(host:string)=>{refreshes.push(host);}}};
 const callbacks=new Function('bridge','desktop',`${body};return {renameSidebarProject,removeSidebarProject,revealSidebarProject};`)(bridge,desktop);
 return{original,calls,refreshes,reveals,records,desktop,callbacks,setError:(value:string)=>{error=value;}};
}
test('actual App rename/remove keep original unselected host and never substitute the selected project',async()=>{
 const f=fixture();await f.callbacks.renameSidebarProject(f.original,'Renamed');await f.callbacks.removeSidebarProject(f.original);
 expect(f.calls).toEqual([{hostId:'remote',envelope:{id:expect.any(String),command:{type:'project.rename',projectId:'same-project',name:'Renamed'}}},{hostId:'remote',envelope:{id:expect.any(String),command:{type:'project.remove',projectId:'same-project'}}}]);expect(f.refreshes).toEqual(['remote','remote']);expect(f.records.get('selected')!.state.projects[0]!.path).toBe('/unrelated');
});
test('stale removed/replaced/offline original refuses before any command and operational failure reaches dialog',async()=>{
 for(const state of ['removed','replaced','offline']){const f=fixture(),record=f.records.get('remote')!;if(state==='removed')record.state.projects=[];if(state==='replaced')record.state.projects[0]!.path='/replacement';if(state==='offline')record.connected=false;await expect(f.callbacks.removeSidebarProject(f.original)).rejects.toThrow('original host');expect(f.calls).toEqual([]);}
 const f=fixture();f.setError('Host refused rename');await expect(f.callbacks.renameSidebarProject(f.original,'New')).rejects.toThrow('Host refused rename');expect(f.refreshes).toEqual([]);
});
test('reveal refuses remote owner and uses only original local project identity',async()=>{
 const f=fixture();await expect(f.callbacks.revealSidebarProject(f.original)).rejects.toThrow('owning desktop');expect(f.reveals).toEqual([]);f.desktop.localHostId='remote';await f.callbacks.revealSidebarProject(f.original);expect(f.reveals).toEqual([['same-project','remote']]);
});

test('an in-flight project action refreshes its captured owner after caller object changes',async()=>{
 const f=fixture();const pending=f.callbacks.renameSidebarProject(f.original,'Renamed');f.original.hostId='selected';f.original.id='replacement';await pending;expect(f.refreshes).toEqual(['remote']);expect(f.calls[0]).toMatchObject({hostId:'remote',envelope:{command:{projectId:'same-project'}}});
});
