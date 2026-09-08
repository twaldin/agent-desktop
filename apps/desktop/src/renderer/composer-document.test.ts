import {expect,test} from 'bun:test';
import {TextSelection,EditorState} from 'prosemirror-state';
import {history,undo,redo} from 'prosemirror-history';
import {composerDocument,readComposerDocument,documentPosition,authoredOffset,remapFileOffsets,composerSchema,replaceAuthoredText} from './composer-document';
import {serializeWholeFilePrompt,wholeFileMarkdownLink} from '@agent-desktop/shared';
import {fromMarkdown} from 'mdast-util-from-markdown';
import {extractFileMentions} from '@oh-my-pi/pi-coding-agent/utils/file-mentions';
import {resolveTranscriptLink} from './transcript-links';
const file=(id:string,textOffset:number)=>({id,textOffset,source:{kind:'file' as const,hostId:'home',path:`/project/${id}.ts`}});
test('inline document round-trips empty, multiline, emoji, tied file positions and authored text independently',()=>{
 const files=[file('a',0),file('b',3),file('c',3),file('d',7)],text='a😀\nbcd';
 const doc=composerDocument(text,files);expect(readComposerDocument(doc)).toEqual({text,files});
 expect(documentPosition(doc,3,'after')-documentPosition(doc,3,'before')).toBe(2);
 for(let offset=0;offset<=text.length;offset++)expect(authoredOffset(doc,documentPosition(doc,offset))).toBe(offset);
 expect(readComposerDocument(composerDocument('',[file('empty',0)]))).toEqual({text:'',files:[file('empty',0)]});
});
test('ProseMirror edit and undo move file anchors with authored text and delete atomic files without path text',()=>{
 let state=EditorState.create({doc:composerDocument('hello',[file('a',2)]),plugins:[history()]});
 const dispatch=(tr:Parameters<typeof state.apply>[0])=>{state=state.apply(tr);};
 dispatch(state.tr.insertText('prefix ',1));expect(readComposerDocument(state.doc)).toEqual({text:'prefix hello',files:[file('a',9)]});
 expect(undo(state,dispatch)).toBe(true);expect(readComposerDocument(state.doc)).toEqual({text:'hello',files:[file('a',2)]});
 expect(redo(state,dispatch)).toBe(true);
 const from=documentPosition(state.doc,9,'before');dispatch(state.tr.delete(from,from+1));expect(readComposerDocument(state.doc)).toEqual({text:'prefix hello',files:[]});
});
test('external text replacement maps anchors and malformed persisted offsets reject instead of being clamped',()=>{
 expect(remapFileOffsets('abc','xabc',[file('a',2)])[0]?.textOffset).toBe(3);
 expect(()=>composerDocument('abc',[file('a',4)])).toThrow('offset');
});

test('completion replacement keeps the caret at the edit and removes only atoms inside the range',()=>{
 let state=EditorState.create({doc:composerDocument('before /abc after',[file('a',2),file('b',10),file('c',15)]),plugins:[history()]});
 const dispatch=(tr:Parameters<typeof state.apply>[0])=>{state=state.apply(tr);};
 dispatch(replaceAuthoredText(state,'before  after'));
 expect(readComposerDocument(state.doc)).toEqual({text:'before  after',files:[file('a',2),file('c',11)]});
 expect(authoredOffset(state.doc,state.selection.from)).toBe(7);
 expect(undo(state,dispatch)).toBe(true);
 expect(readComposerDocument(state.doc).files).toEqual([file('a',2),file('b',10),file('c',15)]);
});

test('sent file links preserve literal filenames through CommonMark and never become extra native @ reads',()=>{
 for(const name of ['file.ts','@secret.txt','a b[1](x).ts','a#L2?x%20:42.ts','a`*_<>&!.txt', '😀.txt']){
  const path=`/project/${name}`,wire=wholeFileMarkdownLink(path);
  const paragraph=fromMarkdown(wire).children[0];
  expect(paragraph?.type).toBe('paragraph');if(paragraph?.type!=='paragraph')throw new Error('Expected paragraph');
  const link=paragraph.children[0];expect(link?.type).toBe('link');if(link?.type!=='link')throw new Error('Expected link');
  expect(link.children).toMatchObject([{type:'text',value:name}]);
  expect(decodeURIComponent(link.url)).toBe(path);
  expect(resolveTranscriptLink(link.url,'/project')).toEqual({kind:'file',file:{path:name}});
  expect(extractFileMentions(wire)).toEqual([]);
 }
});

test('sent serialization retains authored whitespace, emoji offsets, ties and legacy context without inventing placement',()=>{
 const text='a😀\nbcd',files=[file('a',3),file('b',3),file('c',7)];
 expect(serializeWholeFilePrompt(text,files)).toBe(`a😀${wholeFileMarkdownLink('/project/a.ts')}${wholeFileMarkdownLink('/project/b.ts')}\nbcd${wholeFileMarkdownLink('/project/c.ts')}`);
 expect(serializeWholeFilePrompt('',[file('only',0)])).toBe(wholeFileMarkdownLink('/project/only.ts'));
 expect(serializeWholeFilePrompt(' @authored.ts ',[{id:'legacy',source:{kind:'file',hostId:'home',path:'/project/legacy.ts'}}])).toBe(' @authored.ts ');
 expect(()=>serializeWholeFilePrompt('x',[file('bad',2)])).toThrow('offset');
 expect(extractFileMentions(serializeWholeFilePrompt('@authored.ts ',[file('safe',13)]))).toEqual(['authored.ts']);
});
