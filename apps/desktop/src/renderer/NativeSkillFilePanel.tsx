import { useEffect, useSyncExternalStore } from "react";
import { MarkdownText } from "./MarkdownText";
import type { NativeSkillFileController } from "./native-skill-file-state";
import "./native-skill-file-panel.css";

export function NativeSkillFilePanel({ controller, connected, active }: {controller:NativeSkillFileController;connected:boolean;active:boolean}) {
  useSyncExternalStore(controller.subscribe,controller.getVersion,controller.getVersion);
  const data=controller.state;
  useEffect(()=>{void controller.load(connected);},[controller,connected]);
  if(!active)return null;
  return <section className="native-skill-file-panel" tabIndex={-1} aria-label="Skill file editor">
    <header><span title={data.ref.sourcePath}>{data.ref.sourcePath.split("/").at(-1)}</span><div className="native-skill-file-actions">
      <span role="status">{!connected?"Offline":data.saving?"Saving…":data.dirty?"Edited":""}</span>
      <button type="button" onClick={()=>void controller.load()} disabled={!connected||data.saving||data.loading}>Refresh</button>
      <button type="button" aria-pressed={data.source} onClick={()=>controller.toggleSource()}>{data.source?"View preview":"View source"}</button>
    </div></header>
    {data.error&&<p role="alert" className="inline-error">{data.error}</p>}
    {data.notice&&<p role="status">{data.notice}</p>}
    {data.conflict&&<div role="alert"><p>The file changed on its host. Your edits are preserved.</p><button onClick={()=>controller.resolveConflict("use-file")}>Use file</button><button onClick={()=>controller.resolveConflict("keep-changes")}>Keep my changes</button></div>}
    {data.uncertain&&<div role="alert"><p>The previous save is not confirmed.</p><button disabled={!connected||data.saving||data.loading} onClick={()=>void controller.inspectUnknown()}>Inspect file</button><button disabled={!connected||data.saving||data.loading} onClick={()=>void controller.retryUnknown()}>Check same save</button></div>}
    {data.recoveredText!==undefined&&<button onClick={()=>controller.restorePreviousEdits()}>Restore previous edits</button>}
    {data.loading&&!data.file?<p role="status">Loading skill file…</p>:data.source?<textarea aria-label="Skill file source" value={data.text} disabled={!data.file} spellCheck={false} onChange={event=>controller.setText(event.target.value)} onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==="s"){event.preventDefault();void controller.save();}}}/>:<div className="native-skill-file-rendered"><MarkdownText text={data.text} blockKey={`skill-file:${data.ref.skillId}`}/></div>}
  </section>;
}
