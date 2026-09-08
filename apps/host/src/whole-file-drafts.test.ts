import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DraftInput,HostCommand} from '@agent-desktop/shared';
import {HostStore} from './store';
test('whole-file persistence gates rollback, preserves conflicts, and consumes only certified exact revisions',()=>{
 const root=mkdtempSync(join(tmpdir(),'whole-file-store-'));let store=new HostStore(root);
 const file={id:'file',source:{kind:'file' as const,hostId:store.host.id,path:'/project/literal #.ts'}};
 const draft:DraftInput={id:'new-conversation',text:'Read',projectId:null,model:null,wholeFileAttachments:[file]};
 try{
  expect(store.putDraft(draft,0).ok).toBe(true);
  const db=new Database(join(root,'state.sqlite'));try{expect(db.query<{user_version:number},[]>('PRAGMA user_version').get()?.user_version).toBe(9);}finally{db.close();}
  expect(store.putDraft({...draft,text:'other'},0).ok).toBe(false);
  expect(store.listDraftConflicts()[0]?.attempted.wholeFileAttachments).toEqual([file]);
  expect(()=>store.putDraft({...draft,wholeFileAttachments:undefined},1)).toThrow('protocol');
  const command:HostCommand={type:'session.prompt',sessionId:'session',text:draft.text,wholeFileAttachments:[file],draft:{id:draft.id,revision:1}};
  store.claimCommand('send','hash',command);
  expect(()=>store.finishCommand('send','hash',{ok:true,commandId:'send',admission:{kind:'native-command',command:'compact'}})).toThrow('native user');
  expect(store.getDraft(draft.id)?.revision).toBe(1);
  store.finishCommand('send','hash',{ok:true,commandId:'send',admission:{kind:'user-message',entryId:'native-entry'}});
  expect(store.getDraft(draft.id)).toMatchObject({revision:2,text:'',wholeFileAttachments:[],lastConsumption:{commandId:'send',submittedRevision:1}});
  store.close();store=new HostStore(root);
  expect(store.getDraft(draft.id)?.wholeFileAttachments).toEqual([]);
  expect(()=>store.putDraft({...draft,wholeFileAttachments:undefined},2)).toThrow('protocol');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('inline whole-file positions raise schema 10 and survive reopening without a consumption receipt',()=>{
 const root=mkdtempSync(join(tmpdir(),'inline-whole-file-store-'));let store=new HostStore(root);
 const file={id:'inline-file',textOffset:2,source:{kind:'file' as const,hostId:store.host.id,path:'/project/inline.ts'}};
 const draft:DraftInput={id:'inline-draft',text:'a😀b',projectId:null,model:null,wholeFileAttachments:[file]};
 try{
  expect(store.putDraft(draft,0)).toMatchObject({ok:true,draft:{revision:1,text:draft.text,wholeFileAttachments:[file]}});
  const db=new Database(join(root,'state.sqlite'));try{expect(db.query<{user_version:number},[]>('PRAGMA user_version').get()?.user_version).toBe(10);}finally{db.close();}
  store.close();store=new HostStore(root);
  expect(store.getDraft(draft.id)).toMatchObject({revision:1,text:draft.text,wholeFileAttachments:[file]});
  expect(store.getDraft(draft.id)?.lastConsumption).toBeUndefined();
  expect(()=>store.putDraft({...draft,wholeFileAttachments:[{...file,textOffset:draft.text.length+1}]},1)).toThrow('UTF-16');
  expect(()=>store.claimCommand('invalid-inline','hash',{type:'session.prompt',sessionId:'s',text:'a',wholeFileAttachments:[file]})).toThrow('UTF-16');
  expect(store.getCommand('invalid-inline')).toBeUndefined();
  expect(store.getDraft(draft.id)).toMatchObject({revision:1,text:draft.text,wholeFileAttachments:[file]});
  expect(store.getDraft(draft.id)?.lastConsumption).toBeUndefined();
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('repeated inline sources raise schema 11 and retain every mention across reopening',()=>{
 const root=mkdtempSync(join(tmpdir(),'repeated-whole-file-store-'));let store=new HostStore(root);
 const source={kind:'file' as const,hostId:store.host.id,path:'/project/repeated.ts'};
 const files=[{id:'first',textOffset:0,source},{id:'second',textOffset:4,source:{...source}}];
 const draft:DraftInput={id:'repeated-draft',text:'read',projectId:null,model:null,wholeFileAttachments:files};
 try{
  expect(store.putDraft(draft,0)).toMatchObject({ok:true,draft:{wholeFileAttachments:files}});
  const db=new Database(join(root,'state.sqlite'));try{expect(db.query<{user_version:number},[]>('PRAGMA user_version').get()?.user_version).toBe(11);}finally{db.close();}
  store.close();store=new HostStore(root);expect(store.getDraft(draft.id)?.wholeFileAttachments).toEqual(files);
  expect(()=>store.putDraft({...draft,wholeFileAttachments:[{...files[0]!,textOffset:undefined},files[1]!]},1)).toThrow();
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
