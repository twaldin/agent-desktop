import { expect, test } from 'bun:test';
import type { Draft } from '@agent-desktop/shared';
import { appendWholeFile, wholeFileSendIssue, wholeFileOpenTarget } from './whole-file-composer';
const draft:Draft={id:'draft',text:'',projectId:null,model:null,revision:0,updatedAt:0};
test('composer activation preserves literal host files independently of project selection',()=>{
 const source={kind:'file' as const,hostId:'work',path:'/project/a # % :42.ts'};
 expect(wholeFileOpenTarget(source,'work','/project')).toEqual({path:'a # % :42.ts'});
 expect(()=>wholeFileOpenTarget(source,'home','/project')).toThrow('another host');
 expect(wholeFileOpenTarget(source,'work')).toEqual({absolutePath:source.path});
 expect(wholeFileOpenTarget(source,'work','/')).toEqual({absolutePath:source.path});
 expect(wholeFileOpenTarget(source,'work','~')).toEqual({absolutePath:source.path});
 expect(()=>wholeFileOpenTarget({...source,path:'/project/../file'},'work')).toThrow('canonical absolute');
 expect(wholeFileOpenTarget(source,'work','/project/subdir')).toEqual({absolutePath:source.path});
});
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
test('repeated inline insertion retains both caret positions and requires the advertised v9 capability',()=>{
 const source={hostId:'home',path:'/project/a.ts'},text='hello';
 const first=appendWholeFile({...draft,text},'home',source,{textOffset:2,allowRepeated:true});
 const files=appendWholeFile({...draft,text,wholeFileAttachments:first},'home',source,{textOffset:5,allowRepeated:true});
 expect(files.map(file=>file.textOffset)).toEqual([2,5]);expect(files[0]!.id).not.toBe(files[1]!.id);expect(files.map(file=>file.source)).toEqual([{kind:'file',...source},{kind:'file',...source}]);
 const captured={...draft,text,wholeFileAttachments:files},base={commandVersion:7 as const,ordinaryPrompt:true as const,maxFiles:100,inlineMentions:{commandVersion:8 as const}};
 expect(wholeFileSendIssue(captured,'home',false,base)).toContain('repeated');
 expect(wholeFileSendIssue(captured,'home',false,{...base,inlineMentions:{...base.inlineMentions,repeatedSources:{commandVersion:9}}})).toBeUndefined();
 expect(()=>appendWholeFile({...draft,text},'home',source,{textOffset:6,allowRepeated:true})).toThrow('offset');
});
