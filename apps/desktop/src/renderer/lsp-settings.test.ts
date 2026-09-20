import { expect,test } from 'bun:test';
import { LspSettingsState } from './LspSettings';
import { NativeValueField } from './NativeSettings';
import { isValidElement, type ReactElement } from 'react';
import { lspServerFields, type SettingJson, type NativeLspCatalog,type NativeLspMutation } from '@agent-desktop/shared';
const catalog=(revision='r1'):NativeLspCatalog=>({revision,application:'new-sessions',sources:[{id:'user',path:'/fixture/lsp.json',kind:'file',scope:'user',exists:true,writable:true,servers:{example:{command:'old',opaque:{kept:true}}}}],servers:[],warnings:[],overrideTargets:{user:'user',project:'project'}});
const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('conflicting read preserves edits and explicit revision review merges unrelated current fields',async()=>{
 let current=catalog();const mutations:NativeLspMutation[]=[];
 const data=new LspSettingsState({getLspConfiguration:async()=>current,mutateLspConfiguration:async(_target,mutation)=>{mutations.push(mutation);return catalog('r3');},subscribe:()=>()=>{}},'owner',{projectId:'project'});
 data.connected=true;await data.refresh();data.edit(current.sources[0]!,'example');if(data.draft?.kind!=='server')throw Error();data.change({...data.draft,values:{...data.draft.values,command:'edited'}});
 current=catalog('r2');current.sources[0]!.servers.example!.settings={external:true};await data.refresh();expect(data.stale).toBe(true);await data.save();expect(mutations).toHaveLength(0);expect(data.draft?.kind==='server'&&data.draft.values.command).toBe('edited');
 data.reviewLatest();expect(data.draft?.kind==='server'&&data.draft.values.settings).toEqual({external:true});await data.save();expect(mutations[0]).toEqual({operation:'save',name:'example',sourceId:'user',expectedRevision:'r2',changes:{command:'edited'},removeFields:[]});
});
test('disconnect fences outstanding reads and unknown saves while preserving draft; old owner completion cannot cross to new state',async()=>{
 const read=deferred<NativeLspCatalog>(),save=deferred<NativeLspCatalog>();let calls=0;
 const bridge={getLspConfiguration:async()=>++calls===1?catalog():read.promise,mutateLspConfiguration:async()=>save.promise,subscribe:()=>()=>{}};
 const data=new LspSettingsState(bridge,'owner');data.connected=true;await data.refresh();data.edit(data.catalog!.sources[0]!,'example');const pendingRead=data.refresh();const pendingSave=data.save();expect(data.saving).toBe(true);data.disconnect();read.resolve(catalog('stale-read'));save.resolve(catalog('stale-save'));await Promise.all([pendingRead,pendingSave]);expect(data.catalog?.revision).toBe('r1');expect(data.draft).not.toBeNull();expect(data.error).toContain('unknown');
 const other=new LspSettingsState(bridge,'other',{projectId:'other'});expect(other.catalog).toBeNull();expect(other.draft).toBeNull();
});
test('failed saves keep original draft and no second in-flight save is admitted',async()=>{
 const save=deferred<NativeLspCatalog>();let calls=0;const data=new LspSettingsState({getLspConfiguration:async()=>catalog(),mutateLspConfiguration:async()=>{calls++;return save.promise;},subscribe:()=>()=>{}},'owner');data.connected=true;await data.refresh();data.edit(data.catalog!.sources[0]!,'example');const first=data.save();await data.save();expect(calls).toBe(1);save.reject(new Error('source changed'));await first;expect(data.draft).not.toBeNull();expect(data.error).toBe('source changed');
});

test('native nested controls preserve unknown saved values through the LSP save payload',async()=>{
 const current=catalog(),opaque={vendor:{values:[null,true,3,'native']},toString:'native-owned'};
 current.sources[0]!.servers.example={command:'old',opaque:{kept:true},capabilities:{...opaque,flycheck:true},workspaceReadyTimings:{...opaque,timeoutMs:100}};
 const mutations:NativeLspMutation[]=[];
 const data=new LspSettingsState({getLspConfiguration:async()=>current,mutateLspConfiguration:async(_target,mutation)=>{mutations.push(mutation);return catalog('r2');},subscribe:()=>()=>{}},'owner',{projectId:'project'});
 data.connected=true;await data.refresh();data.edit(current.sources[0]!,'example');
 const find=(node:unknown,predicate:(element:ReactElement<any>)=>boolean):ReactElement<any>|undefined=>{
  if(Array.isArray(node)){for(const child of node){const found=find(child,predicate);if(found)return found;}return;}
  if(!isValidElement<any>(node))return;
  return predicate(node)?node:find(node.props.children,predicate);
 };
 const editControl=(field:'capabilities'|'workspaceReadyTimings',key:string,event:unknown)=>{
  if(data.draft?.kind!=='server')throw Error('Missing server draft');
  const draft=data.draft,descriptor=lspServerFields[field]!;
  const tree=NativeValueField({schema:descriptor.schema,value:draft.values[field]!,label:descriptor.label,onChange:(value:SettingJson)=>data.change({...draft,values:{...draft.values,[field]:value}})});
  const child=find(tree,element=>element.type===NativeValueField&&element.props.label===`${descriptor.label} ${key}`);
  if(!child)throw Error('Missing nested control');
  const control=find(NativeValueField(child.props),element=>element.type==='input');
  if(!control)throw Error('Missing input');
  control.props.onChange(event);
 };
 editControl('capabilities','flycheck',{target:{checked:false}});
 editControl('workspaceReadyTimings','timeoutMs',{target:{value:'250'}});
 await data.save();
 expect(mutations).toEqual([{operation:'save',sourceId:'user',expectedRevision:'r1',name:'example',changes:{capabilities:{...opaque,flycheck:false},workspaceReadyTimings:{...opaque,timeoutMs:250}},removeFields:[]}]);
 expect(current.sources[0]!.servers.example!.capabilities).toEqual({...opaque,flycheck:true});
 expect(current.sources[0]!.servers.example!.workspaceReadyTimings).toEqual({...opaque,timeoutMs:100});
});
