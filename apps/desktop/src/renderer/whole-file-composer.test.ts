import { expect, test } from 'bun:test';
import type { Draft } from '@agent-desktop/shared';
import { appendWholeFile, wholeFileSendIssue } from './whole-file-composer';
const draft:Draft={id:'draft',text:'',projectId:null,model:null,revision:0,updatedAt:0};
test('whole-file staging binds to the draft host, deduplicates source identities, and keeps literal paths',()=>{
 const source={hostId:'home',path:'/project/a # % :.ts'};
 const files=appendWholeFile(draft,'home',source);
 expect(files[0]?.source).toEqual({kind:'file',...source});
 expect(appendWholeFile({...draft,wholeFileAttachments:files},'home',source)).toEqual(files);
 expect(()=>appendWholeFile(draft,'other',source)).toThrow('host');
 expect(draft.wholeFileAttachments).toBeUndefined();
});
test('unsupported, foreign and running sends preserve references rather than dropping context',()=>{
 const captured={...draft,wholeFileAttachments:appendWholeFile(draft,'home',{hostId:'home',path:'/project/a.ts'})};
 const caps={commandVersion:7 as const,ordinaryPrompt:true as const,maxFiles:100};
 expect(wholeFileSendIssue(captured,'home',false,caps)).toBeUndefined();
 expect(wholeFileSendIssue(captured,'home',false)).toContain('Update');
 expect(wholeFileSendIssue(captured,'other',false,caps)).toContain('another host');
 expect(wholeFileSendIssue(captured,'home',true,caps)).toContain('finishes');
 expect(wholeFileSendIssue({...captured,text:'/compact'},'home',false,caps)).toContain('commands');
 expect(captured.wholeFileAttachments).toHaveLength(1);
});
