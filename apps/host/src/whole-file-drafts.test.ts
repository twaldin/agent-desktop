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
