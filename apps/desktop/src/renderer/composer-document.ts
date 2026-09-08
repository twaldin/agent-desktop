import { Schema, type Node as ProseMirrorNode } from 'prosemirror-model';
import { TextSelection, type EditorState } from 'prosemirror-state';
import { parseWholeFileAttachments, type WholeFileAttachment } from '@agent-desktop/shared';

export const composerSchema = new Schema({nodes:{
 doc:{content:'paragraph'},
 paragraph:{content:'inline*',toDOM:()=>['p',0]},
 text:{group:'inline'},
 hard_break:{inline:true,group:'inline',selectable:false,toDOM:()=>['br']},
 file:{inline:true,group:'inline',atom:true,selectable:false,draggable:false,attrs:{id:{},hostId:{},path:{}},toDOM:node=>['span',{'data-file-id':node.attrs.id,contenteditable:'false',class:'composer-inline-file'},node.attrs.path.split('/').at(-1)]},
}});
export interface ComposerDocument {text:string;files:WholeFileAttachment[]}
export function composerDocument(text:string,files:readonly WholeFileAttachment[]=[]):ProseMirrorNode {
 const checked=parseWholeFileAttachments(files,text.length);
 const ordered=checked.map((file,index)=>({file,index,offset:file.textOffset??0})).sort((a,b)=>a.offset-b.offset||a.index-b.index);
 const nodes:ProseMirrorNode[]=[];let cursor=0;
 const append=(value:string)=>value.split('\n').forEach((part,index)=>{if(index)nodes.push(composerSchema.nodes.hard_break!.create());if(part)nodes.push(composerSchema.text(part));});
 for(const {file,offset} of ordered){append(text.slice(cursor,offset));nodes.push(composerSchema.nodes.file!.create({id:file.id,hostId:file.source.hostId,path:file.source.path}));cursor=offset;}
 append(text.slice(cursor));return composerSchema.nodes.doc!.create(null,composerSchema.nodes.paragraph!.create(null,nodes));
}
export function readComposerDocument(doc:ProseMirrorNode):ComposerDocument {
 let text='';const files:WholeFileAttachment[]=[];
 doc.firstChild?.forEach(node=>{if(node.isText)text+=node.text;else if(node.type.name==='hard_break')text+='\n';else if(node.type.name==='file')files.push({id:node.attrs.id,source:{kind:'file',hostId:node.attrs.hostId,path:node.attrs.path},textOffset:text.length});});
 return {text,files:parseWholeFileAttachments(files,text.length)};
}
export function authoredOffset(doc:ProseMirrorNode,position:number):number {
 let offset=0;doc.firstChild?.forEach((node,pos)=>{const start=pos+1;if(position<=start)return;if(node.isText)offset+=Math.min(position-start,node.nodeSize);else if(node.type.name==='hard_break')offset++;});return offset;
}
export function documentPosition(doc:ProseMirrorNode,offset:number,bias:'before'|'after'='after'):number {
 let text=0,pos=1;const paragraph=doc.firstChild;if(!paragraph)return 1;
 for(let i=0;i<paragraph.childCount;i++){
  const node=paragraph.child(i);
  if(node.type.name==='file'){if(text===offset&&bias==='before')return pos;pos+=node.nodeSize;continue;}
  const length=node.isText?node.nodeSize:1;
  if(offset<text+length)return pos+Math.max(0,offset-text);
  text+=length;pos+=node.nodeSize;
 }
 return Math.min(pos,doc.content.size-1);
}
/** Preserve anchors for external text replacements; editor transactions map nodes exactly. */
export function remapFileOffsets(before:string,after:string,files:readonly WholeFileAttachment[]):WholeFileAttachment[]{
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 let end=before.length,nextEnd=after.length;while(end>start&&nextEnd>start&&before[end-1]===after[nextEnd-1]){end--;nextEnd--;}
 return files.map(file=>{const offset=file.textOffset??0;return{...file,textOffset:offset<=start?offset:offset>=end?offset+nextEnd-end:nextEnd};});
}

/** Apply completion text as a bounded edit, preserving PM node/history semantics. */
export function replaceAuthoredText(state:EditorState,after:string){
 const before=readComposerDocument(state.doc).text;
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 let end=before.length,nextEnd=after.length;while(end>start&&nextEnd>start&&before[end-1]===after[nextEnd-1]){end--;nextEnd--;}
 const from=documentPosition(state.doc,start),to=end===start?from:documentPosition(state.doc,end,'before');
 const content=composerDocument(after.slice(start,nextEnd)).firstChild!.content;
 const tr=state.tr.replaceWith(from,to,content);
 tr.setSelection(TextSelection.create(tr.doc,from+content.size));
 return tr.scrollIntoView();
}
