import { useEffect, useRef, useSyncExternalStore } from "react";
import { markdownImagePath } from "./markdown-images";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { PierreSourceEditor } from "./PierreSourceEditor";
import type { NativeSkillFileController } from "./native-skill-file-state";
import "./native-skill-file-panel.css";

export function NativeSkillFilePanel({ controller, connected, active, fileMode, onFileModeChange, openExternal }: {controller:NativeSkillFileController;connected:boolean;active:boolean;fileMode?:"markdown"|"source";onFileModeChange?(mode:"markdown"|"source"):void;openExternal?(url:string):Promise<void>}) {
  useSyncExternalStore(controller.subscribe,controller.getVersion,controller.getVersion);
  const data=controller.state;
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
    </div></header>
    {data.error&&<p role="alert" className="inline-error">{data.error}</p>}
    {data.notice&&<p role="status">{data.notice}</p>}
    {data.conflict&&<div role="alert"><p>The file changed on its host. Your edits are preserved.</p><button onClick={()=>controller.resolveConflict("use-file")}>Use file</button><button onClick={()=>controller.resolveConflict("keep-changes")}>Keep my changes</button></div>}
    {data.uncertain&&<div role="alert"><p>The previous save is not confirmed.</p><button disabled={!connected||data.saving||data.loading} onClick={()=>void controller.inspectUnknown()}>Inspect file</button><button disabled={!connected||data.saving||data.loading} onClick={()=>void controller.retryUnknown()}>Check same save</button></div>}
    {data.recoveredText!==undefined&&<button onClick={()=>controller.restorePreviousEdits()}>Restore previous edits</button>}
    {data.loading&&!data.file?<p role="status">Loading skill file…</p>:data.file&&<>
      <RichMarkdownEditor documentKey={documentKey} value={data.text} label="Skill file Markdown" active={active&&!source}
        imageGeneration={controller.imageGeneration}
        resolveImage={href=>{const parent=data.ref.sourcePath.slice(0,data.ref.sourcePath.lastIndexOf("/"))||"/";const path=markdownImagePath(href,data.ref.sourcePath.split("/").at(-1)!,parent);return path===null?null:{key:`${documentKey}:${controller.imageGeneration}:${path}`,load:()=>controller.acquireImage(path)};}}
        onChange={text=>controller.setText(text)} onSave={()=>void controller.save()} openExternal={openExternal}/>
      <PierreSourceEditor documentKey={documentKey} name="SKILL.md" value={data.text} label="Skill file source" active={active&&source}
        onChange={text=>controller.setText(text)} onSave={()=>void controller.save()}/>
    </>}
  </section>;
}
