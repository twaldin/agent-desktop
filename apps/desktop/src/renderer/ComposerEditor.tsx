import { useLayoutEffect, useRef, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Slice, type Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo, closeHistory } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import type { WholeFileAttachment } from '@agent-desktop/shared';
import { TreeFileIcon } from './TreeFileIcon';
import { authoredOffset, composerDocument, composerSchema, documentPosition, readComposerDocument, replaceAuthoredText } from './composer-document';
import 'prosemirror-view/style/prosemirror.css';
import './composer-editor.css';

/** Small shared interface used by both the rich main composer and textarea-only surfaces. */
export interface ComposerInput {focus():void;readonly selectionStart:number;readonly selectionEnd:number;setSelectionRange(start:number,end:number):void;closest(selector:string):Element|null}
export interface ComposerEditorHandle extends ComposerInput { readonly element:HTMLElement; replaceText(text:string):void; insertFile(file:WholeFileAttachment,range?:{start:number;end:number}):void }
interface Props {
 inputRef:RefObject<ComposerEditorHandle|null>; scope:string; text:string; files?:readonly WholeFileAttachment[]; disabled?:boolean;placeholder:string;
 onChange(value:{text:string;files:WholeFileAttachment[]}):void;
 onSelection?():void;onFocus?():void;onBlur?():void;onCompositionStart?():void;onCompositionEnd?():void;
 onKeyDown?(event:ReactKeyboardEvent<HTMLElement>):void;
 ariaControls?:string;ariaExpanded?:boolean;ariaActiveDescendant?:string;
}
export function ComposerEditor(props:Props){
 const mount=useRef<HTMLDivElement>(null),viewRef=useRef<EditorView|null>(null),lastPropDocument=useRef<ProseMirrorNode|null>(null),latest=useRef(props);latest.current=props;
 useLayoutEffect(()=>{
  const roots=new Set<Root>();let view:EditorView;
  const newline=(state:EditorState,dispatch?:EditorView['dispatch'])=>{dispatch?.(state.tr.replaceSelectionWith(composerSchema.nodes.hard_break!.create()).scrollIntoView());return true;};
  view=new EditorView(mount.current!,{
   state:EditorState.create({doc:composerDocument(latest.current.text,latest.current.files),plugins:[history(),keymap({'Mod-z':undo,'Shift-Mod-z':redo,'Mod-y':redo,Enter:newline,'Shift-Enter':newline}),keymap(baseKeymap)]}),
   editable:()=>!latest.current.disabled,
   attributes:{id:'prompt',role:'textbox','aria-multiline':'true',spellcheck:'true',class:'composer-rich-input'},
   nodeViews:{file:node=>{
    const dom=document.createElement('span');dom.className='composer-inline-file';dom.contentEditable='false';dom.title=node.attrs.path;dom.dataset.fileId=node.attrs.id;
    const icon=document.createElement('span');icon.className='composer-inline-file-icon';const root=createRoot(icon);roots.add(root);root.render(<TreeFileIcon path={node.attrs.path}/>);
    const label=document.createElement('span');label.textContent=node.attrs.path.split('/').at(-1);dom.append(icon,label);
    return{dom,selectNode:()=>dom.classList.add('ProseMirror-selectednode'),deselectNode:()=>dom.classList.remove('ProseMirror-selectednode'),destroy:()=>{roots.delete(root);queueMicrotask(()=>root.unmount());}};
   }},
   dispatchTransaction:transaction=>{const state=view.state.apply(transaction);view.updateState(state);if(transaction.docChanged)latest.current.onChange(readComposerDocument(state.doc));if(transaction.selectionSet||transaction.docChanged)latest.current.onSelection?.();},
   handleDOMEvents:{drop:(_editor,event)=>{if(!event.dataTransfer?.files.length)return false;event.preventDefault();return true;},focus:()=>{latest.current.onFocus?.();return false;},blur:()=>{latest.current.onBlur?.();return false;},compositionstart:()=>{latest.current.onCompositionStart?.();return false;},compositionend:()=>{latest.current.onCompositionEnd?.();return false;}},
   handlePaste:(editor,event)=>{
    if(!event.clipboardData)return false;if(event.clipboardData.files.length){event.preventDefault();return true;}const text=event.clipboardData.getData('text/plain');event.preventDefault();
    const slice=composerDocument(text).firstChild!.content;editor.dispatch(editor.state.tr.replaceSelection(new Slice(slice,0,0)).scrollIntoView());return true;
   },
   clipboardTextSerializer:slice=>slice.content.textBetween(0,slice.content.size,'\n',node=>node.type.name==='file'?node.attrs.path:'\n'),
  });
  viewRef.current=view;lastPropDocument.current=view.state.doc;
  props.inputRef.current={get element(){return view.dom;},focus:()=>view.focus(),closest:selector=>view.dom.closest(selector),get selectionStart(){return authoredOffset(view.state.doc,view.state.selection.from);},get selectionEnd(){return authoredOffset(view.state.doc,view.state.selection.to);},setSelectionRange:(start,end)=>view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,documentPosition(view.state.doc,start),documentPosition(view.state.doc,end))).scrollIntoView()),replaceText:text=>{view.dispatch(replaceAuthoredText(view.state,text));},insertFile:(file,range)=>{
   const state=view.state;const tr=closeHistory(state.tr);const existing=readComposerDocument(state.doc).files.find(item=>item.source.hostId===file.source.hostId&&item.source.path===file.source.path);
   if(range)tr.setSelection(TextSelection.create(tr.doc,documentPosition(tr.doc,range.start,'before'),documentPosition(tr.doc,range.end)));
   if(existing){if(range)tr.deleteSelection();}else tr.replaceSelectionWith(composerSchema.nodes.file!.create({id:file.id,hostId:file.source.hostId,path:file.source.path}));
   view.dispatch(tr.scrollIntoView());view.dispatch(closeHistory(view.state.tr));view.focus();
  }};
  return()=>{props.inputRef.current=null;viewRef.current=null;view.destroy();for(const root of roots)queueMicrotask(()=>root.unmount());roots.clear();};
 },[props.scope]);
 useLayoutEffect(()=>{
  const view=viewRef.current;if(!view)return;const desired=composerDocument(props.text,props.files);
  const changedProps=!lastPropDocument.current?.eq(desired);lastPropDocument.current=desired;
  if(changedProps&&!view.state.doc.eq(desired)){
   const start=authoredOffset(view.state.doc,view.state.selection.from),end=authoredOffset(view.state.doc,view.state.selection.to);
   // A different document is a remote restore/conflict resolution, not a local echo.
   // Reset history so undo cannot resurrect a superseded cross-device draft.
   view.updateState(EditorState.create({doc:desired,plugins:view.state.plugins,selection:TextSelection.create(desired,documentPosition(desired,Math.min(start,props.text.length)),documentPosition(desired,Math.min(end,props.text.length)))}));
  }
  view.setProps({editable:()=>!props.disabled,attributes:{id:'prompt',role:'textbox','aria-label':'Prompt','aria-multiline':'true','aria-describedby':'prompt-keyboard-hint','aria-disabled':String(Boolean(props.disabled)),'aria-autocomplete':'list','aria-controls':props.ariaControls??'','aria-expanded':String(Boolean(props.ariaExpanded)),'aria-activedescendant':props.ariaActiveDescendant??'',spellcheck:'true',class:'composer-rich-input','data-placeholder':props.placeholder,'data-empty':String(!props.text&&!props.files?.length)}});
 },[props.text,props.files,props.disabled,props.placeholder,props.ariaControls,props.ariaExpanded,props.ariaActiveDescendant]);
 return <div className="composer-editor" ref={mount} onKeyDownCapture={props.onKeyDown}/>;
}
