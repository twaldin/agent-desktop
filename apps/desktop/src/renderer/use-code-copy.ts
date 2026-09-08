import {useEffect, useRef, useState} from 'react';

/** Clipboard completion belongs to the source revision that initiated it. */
export function useCodeCopy(source: string) {
  const [state,setState]=useState<'idle'|'pending'|'copied'|'failed'>('idle');
  const [error,setError]=useState<string>();
  const mounted=useRef(true), current=useRef(source), busy=useRef(false);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  current.current=source;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clearTimeout(timer.current);};},[]);
  useEffect(()=>{clearTimeout(timer.current);setState(busy.current?'pending':'idle');setError(undefined);},[source]);
  const copy=async()=>{
    if(busy.current||state==='copied')return;
    busy.current=true;setState('pending');setError(undefined);clearTimeout(timer.current);
    try{
      if(typeof navigator.clipboard?.writeText!=='function')throw new Error('Clipboard writing is unavailable.');
      await navigator.clipboard.writeText(source);
      if(mounted.current&&current.current===source){setState('copied');timer.current=setTimeout(()=>{if(mounted.current)setState('idle');},2000);}
    }catch(cause){if(mounted.current&&current.current===source){setState('failed');setError(cause instanceof Error?cause.message:'Could not copy this code.');}}
    finally{busy.current=false;if(mounted.current&&current.current!==source)setState('idle');}
  };
  return {state,error,copy};
}
