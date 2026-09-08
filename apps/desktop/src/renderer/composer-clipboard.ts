import type { Slice } from 'prosemirror-model';
import { parseInlineWholeFileMentions, type WholeFileAttachment } from '@agent-desktop/shared';
import type { ComposerDocument } from './composer-document';

/** Native composer clipboard grammar; this is not the model-prompt serializer. */
export function clipboardFileLink(path:string):string {
 const label=path.split('/').at(-1)!;
 return `[${label.replaceAll('\\','\\\\').replaceAll('](',']\\(').replaceAll(']','\\]')}](${path.replaceAll('\\','\\\\').replaceAll(')','\\)')})`;
}
export function composerClipboardText(slice:Slice):string {
 return slice.content.textBetween(0,slice.content.size,'\n',node=>node.type.name==='file'?clipboardFileLink(node.attrs.path):'\n');
}
const unescape=(value:string)=>value.replace(/\\([!-/:-@\[-`{-~])/g,'$1');
function closing(text:string,start:number,char:string):number {
 for(let i=start;i<text.length;i++){if(text[i]==='\n'||text[i]==='\r')return -1;if(text[i]==='\\'){i++;continue;}if(text[i]===char)return i;}return -1;
}
function file(path:string,hostId:string|undefined,textOffset:number):WholeFileAttachment {
 if(!hostId)throw new Error('Choose a host before pasting file mentions. Your draft is unchanged.');
 const item:WholeFileAttachment={id:crypto.randomUUID(),textOffset,source:{kind:'file',hostId,path}};
 parseInlineWholeFileMentions([item],textOffset);return item;
}
/** Restore local absolute path links only. Ordinary web links and prose stay authored text. */
export function parseClipboardText(input:string,hostId?:string):ComposerDocument {
 let text='',cursor=0;const files:WholeFileAttachment[]=[];
 for(let i=0;i<input.length;i++){
  if(input[i]==='\\'){i++;continue;}if(input[i]!=='[')continue;
  const labelEnd=closing(input,i+1,']');if(labelEnd<=i+1||input[labelEnd+1]!=='(')continue;
  const end=closing(input,labelEnd+2,')');if(end<0)continue;
  const path=unescape(input.slice(labelEnd+2,end));if(!path.startsWith('/')){i=end;continue;}
  // Reject an invalid local reference atomically; never turn it into a different file.
  const item=file(path,hostId,text.length+i-cursor);text+=input.slice(cursor,i);files.push(item);cursor=end+1;i=end;
 }
 text+=input.slice(cursor);return {text,files:parseInlineWholeFileMentions(files,text.length)};
}
/** Parse an inert template, never attach clipboard markup or load its resources. */
export function parseComposerClipboard(data:Pick<DataTransfer,'getData'>,hostId?:string,ownerDocument:Document=document):ComposerDocument {
 const html=data.getData('text/html'),plain=data.getData('text/plain');
 if(!html)return parseClipboardText(plain,hostId);
 const template=ownerDocument.createElement('template');template.innerHTML=html;
 if(!template.content.querySelector('[at-mention-path], [data-agent-desktop-file]'))return parseClipboardText(plain,hostId);
 let text='',pendingBreak=false;const files:WholeFileAttachment[]=[];
 const append=(value:string)=>{if(!value)return;if(pendingBreak&&text&&!text.endsWith('\n'))text+='\n';pendingBreak=false;text+=value;};
 const walk=(node:Node)=>{
  if(node.nodeType===3){append(node.textContent??'');return;}if(node.nodeType!==1)return;
  const element=node as Element,tag=element.tagName.toLowerCase();
  if(['script','style','iframe','object','template','noscript'].includes(tag))return;
  if(element.hasAttribute('at-mention-path')||element.hasAttribute('data-agent-desktop-file')){
   const path=element.getAttribute('at-mention-fs-path')||element.getAttribute('at-mention-path'),label=element.getAttribute('at-mention-label');
   const owner=element.getAttribute('data-agent-desktop-host');
   if(!path||!label||!element.getAttribute('at-mention-path')||(element.hasAttribute('data-agent-desktop-file')&&!owner))throw new Error('The copied file mention is incomplete. Your draft is unchanged.');
   if(pendingBreak&&text&&!text.endsWith('\n'))text+='\n';pendingBreak=false;
   if(owner&&owner!==hostId)throw new Error('This copied file belongs to another host. Switch to its host before pasting. Your draft is unchanged.');
   files.push(file(path,hostId,text.length));return;
  }
  if(tag==='br'){append('\n');return;}
  const block=['p','div','li','pre','blockquote','h1','h2','h3','h4','h5','h6'].includes(tag);
  if(block&&text)pendingBreak=true;for(const child of element.childNodes)walk(child);if(block)pendingBreak=true;
 };
 for(const child of template.content.childNodes)walk(child);
 return {text,files:parseInlineWholeFileMentions(files,text.length)};
}
