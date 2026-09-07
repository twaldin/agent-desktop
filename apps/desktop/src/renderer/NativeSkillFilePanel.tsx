import { WorkspaceFileOpen } from "./WorkspaceFileOpen";
import type { WorkspaceQuery, WorkspaceQueryResult, WorkspaceMutation } from "@agent-desktop/shared";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { MarkdownCopyButton } from "./MarkdownCopyButton";
import { markdownImagePath } from "./markdown-images";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { PierreSourceEditor } from "./PierreSourceEditor";
import type { NativeSkillFileController } from "./native-skill-file-state";
import "./native-skill-file-panel.css";

export function NativeSkillFilePanel({ controller, connected, active, fileMode, onFileModeChange, fileScroll, onFileScrollChange, openExternal }: {controller:NativeSkillFileController;connected:boolean;active:boolean;fileMode?:"markdown"|"source";onFileModeChange?(mode:"markdown"|"source"):void;fileScroll?:{markdown?:number;source?:number};onFileScrollChange?(mode:"markdown"|"source",top:number):void;openExternal?(url:string):Promise<void>}) {
  useSyncExternalStore(controller.subscribe,controller.getVersion,controller.getVersion);
  const data=controller.state;
  const openAccess=useMemo(()=>({connected,canSaveCopy:controller.canSaveCopy,cacheWarning:undefined,errors:{},
    query:async(query:WorkspaceQuery):Promise<WorkspaceQueryResult>=>{if(query.type!=="file.open-options"||query.path!==controller.state.ref.sourcePath)throw new Error("Select this skill file.");return controller.getOpenOptions();},
    mutate:async(action:WorkspaceMutation)=>{if(action.type!=="file.open"||action.path!==controller.state.ref.sourcePath)throw new Error("Select this skill file.");return controller.openFile(action.targetId);},
    saveCopy:()=>controller.saveCopy(),
  }),[controller,connected]);
  const source=fileMode===undefined?data.source:fileMode==="source";
  useEffect(()=>{void controller.load(connected);},[controller,connected]);
  const modeRequest=useRef<AbortController|null>(null);
  useEffect(()=>()=>{modeRequest.current?.abort();modeRequest.current=null;},[controller,active,fileMode]);
  const switchMode=()=>{
    if(modeRequest.current)return;
    const request=new AbortController();modeRequest.current=request;
    void controller.toggleSource(request.signal,!source).then(saved=>{
      if(saved&&!request.signal.aborted)onFileModeChange?.(source?"markdown":"source");
    }).finally(()=>{if(modeRequest.current===request)modeRequest.current=null;});
  };
  const documentKey=`${data.hostId}:${data.ref.skillId}:${data.ref.sourcePath}`;
  return <section className="native-skill-file-panel" hidden={!active} tabIndex={-1} aria-label="Skill file editor">
    <header><span title={data.ref.sourcePath}>{data.ref.sourcePath.split("/").at(-1)}</span><div className="native-skill-file-actions">
      <span role="status">{!connected?"Offline":data.saving?"Saving…":data.dirty?"Edited":""}</span>
      <button type="button" onClick={()=>void controller.load()} disabled={!connected||data.saving||data.loading}>Refresh</button>
      <button type="button" aria-pressed={source} disabled={!data.file||data.loading||data.switchingSource} onClick={switchMode}>{source?"View preview":"View source"}</button>
      <WorkspaceFileOpen data={openAccess} path={data.ref.sourcePath} active={active} disabled={!data.file||data.loading}/>
    </div></header>
    {data.openError&&controller.pendingOpenTarget&&<div role="alert"><p>{data.openError}</p><button disabled={!connected||data.opening} onClick={()=>void controller.retryOpen().catch(()=>{})}>Check Open receipt</button></div>}
    {data.error&&<p role="alert" className="inline-error">{data.error}</p>}
    {data.notice&&<p role="status">{data.notice}</p>}
    {data.conflict&&<div role="alert"><p>The file changed on its host. Your edits are preserved.</p><button onClick={()=>controller.resolveConflict("use-file")}>Use file</button><button onClick={()=>controller.resolveConflict("keep-changes")}>Keep my changes</button></div>}
    {data.uncertain&&<div role="alert"><p>The previous save is not confirmed.</p><button disabled={!connected||data.saving||data.loading} onClick={()=>void controller.inspectUnknown()}>Inspect file</button><button disabled={!connected||data.saving||data.loading} onClick={()=>void controller.retryUnknown()}>Check same save</button></div>}
    {data.recoveredText!==undefined&&<button onClick={()=>controller.restorePreviousEdits()}>Restore previous edits</button>}
    {data.loading&&!data.file?<p role="status">Loading skill file…</p>:data.file&&<div className="native-skill-file-body">
      <div className="workspace-markdown-actions"><MarkdownCopyButton key={documentKey} text={data.text}/></div>
      <RichMarkdownEditor documentKey={documentKey} value={data.text} label="Skill file Markdown" active={active&&!source}
        initialScrollTop={fileScroll?.markdown} onScrollChange={top=>onFileScrollChange?.("markdown",top)}
        imageGeneration={controller.imageGeneration}
        resolveImage={href=>{const parent=data.ref.sourcePath.slice(0,data.ref.sourcePath.lastIndexOf("/"))||"/";const path=markdownImagePath(href,data.ref.sourcePath.split("/").at(-1)!,parent);return path===null?null:{key:`${documentKey}:${controller.imageGeneration}:${path}`,load:()=>controller.acquireImage(path)};}}
        onChange={text=>controller.setText(text)} onSave={()=>void controller.save()} openExternal={openExternal}/>
      <PierreSourceEditor documentKey={documentKey} name="SKILL.md" value={data.text} label="Skill file source" active={active&&source}
        initialScrollTop={fileScroll?.source} onScrollChange={top=>onFileScrollChange?.("source",top)}
        onChange={text=>controller.setText(text)} onSave={()=>void controller.save()}/>
    </div>}
  </section>;
}
