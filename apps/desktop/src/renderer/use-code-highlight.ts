import {useEffect, useRef, useState, type RefObject} from 'react';
import {highlightCode, type TranscriptCodeHighlight} from './transcript-code-highlight';

/** Show source first. Enhance nearby blocks, at most once per 120ms per block,
 * retaining any highlighted prefix while the remaining source streams in.
 */
export function useCodeHighlight(code:string, language:string, element:RefObject<HTMLDivElement|null>) {
  const [visible,setVisible]=useState(false);
  const [result,setResult]=useState<{code:string;language:string;highlighted:TranscriptCodeHighlight}>({code:'',language,highlighted:{kind:'plain'}});
  const lastStart=useRef<number|null>(null);
  useEffect(()=>{
    const node=element.current;if(!node)return;
    if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'600px 0px'});
    observer.observe(node);return()=>observer.disconnect();
  },[element]);
  useEffect(()=>{
    if(!visible || result.code===code&&result.language===language&&lastStart.current!==null)return;
    const update=()=>{lastStart.current=performance.now();setResult({code,language,highlighted:highlightCode(code,language)});};
    const timer=setTimeout(update,lastStart.current===null?0:Math.max(0,120-(performance.now()-lastStart.current)));
    return()=>clearTimeout(timer);
  },[code,language,visible,result.code,result.language]);
  const compatible=result.language===language&&code.startsWith(result.code);
  return compatible?{...result,tail:code.slice(result.code.length)}:{code,language,highlighted:{kind:'plain' as const},tail:''};
}
