import { useEffect, useRef, useState } from "react";
import type { NativeSessionMcpResourceResult } from "@agent-desktop/shared";
import { Icon } from "./Icons";

export function SessionMcpResource({ serverName, initialUri, read, onClose }: {
  serverName: string; initialUri: string; read(uri:string): Promise<NativeSessionMcpResourceResult>; onClose():void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0), reading = useRef(false);
  const [uri,setUri] = useState(initialUri), [result,setResult] = useState<NativeSessionMcpResourceResult | null>(null);
  const [busy,setBusy] = useState(false), [error,setError] = useState<string | null>(null);
  useEffect(() => {
    const element=dialog.current, opener=document.activeElement;
    element?.showModal(); element?.querySelector("input")?.focus();
    return () => { generation.current++; element?.close(); if(opener instanceof HTMLElement && opener.isConnected)opener.focus(); };
  }, []);
  const load = async () => {
    if (!uri || reading.current) return;
    const current = generation.current; reading.current=true; setBusy(true); setError(null); setResult(null);
    try { const value = await read(uri); if(current===generation.current)setResult(value); }
    catch(error) { if(current===generation.current)setError(error instanceof Error ? error.message : "The native resource could not be read."); }
    finally { if(current===generation.current){reading.current=false;setBusy(false);} }
  };
  // Opening metadata never fetches a body. The explicit Read action also covers template URIs.
  return <dialog ref={dialog} className="app-dialog mcp-resource-dialog" aria-label="MCP resource" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <header className="mcp-resource-heading"><div><h2>Resource</h2><span className="integration-note">{serverName}</span></div><button className="icon-button" aria-label="Close resource" onClick={onClose}><Icon name="close"/></button></header>
    <form onSubmit={event=>{event.preventDefault();void load();}}><label className="field-label" htmlFor="mcp-resource-uri">Resource URI</label><div className="mcp-resource-request"><input id="mcp-resource-uri" className="text-field" value={uri} onChange={event=>setUri(event.target.value)} maxLength={16384} spellCheck={false}/><button className="secondary-button" disabled={!uri || busy}>{busy ? "Reading…" : "Read resource"}</button></div></form>
    {busy && <p role="status" className="integration-note">Reading from the native server…</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {result && <div className="mcp-resource-contents">{result.contents.length===0 && <p className="integration-note">The server returned no content.</p>}{result.contents.map((item,index)=><ResourceContent key={index} item={item} index={index}/>)}</div>}
  </dialog>;
}

function ResourceContent({item,index}:{item:NativeSessionMcpResourceResult['contents'][number];index:number}) {
  const [url,setUrl] = useState<string>();
  useEffect(()=>{
    const data = item.text !== undefined ? item.text : Uint8Array.from(atob(item.blob!), c=>c.charCodeAt(0));
    // Downloads are inert bytes even when the server labels them HTML or SVG.
    const objectUrl = URL.createObjectURL(new Blob([data],{type:"application/octet-stream"}));
    setUrl(objectUrl);return()=>URL.revokeObjectURL(objectUrl);
  },[item]);
  const image = item.blob !== undefined && /^(image\/(png|jpeg|gif|webp|avif))$/i.test(item.mimeType??"");
  return <section><div className="mcp-resource-meta"><code>{item.uri}</code><small>{item.mimeType??(item.text!==undefined?"Text":"Binary")}</small>{url&&<a href={url} download={`resource-${index+1}${item.text!==undefined?'.txt':'.bin'}`}>Download</a>}</div>
    {item.text!==undefined ? <pre tabIndex={0}>{item.text}</pre> : image ? <img src={`data:${item.mimeType};base64,${item.blob}`} alt={`Resource ${item.uri}`}/> : <p className="integration-note">Binary resource · {atob(item.blob!).length.toLocaleString()} bytes</p>}
  </section>;
}
