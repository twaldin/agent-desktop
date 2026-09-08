import {expect,test} from 'bun:test';
import {TextSelection,EditorState} from 'prosemirror-state';
import {history,undo,redo} from 'prosemirror-history';
import {composerDocument,readComposerDocument,documentPosition,authoredOffset,remapFileOffsets,composerSchema,replaceAuthoredText} from './composer-document';
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
