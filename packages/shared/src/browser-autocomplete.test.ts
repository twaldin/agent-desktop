import { expect, test } from "bun:test";
import { parseBrowserAutocompleteRequest, parseBrowserAutocompleteResult, type BrowserAutocompleteRequest, type BrowserAutocompleteResult } from "./browser-autocomplete";

const target={workerPid:42,name:"tab",targetId:"target"};
const start:BrowserAutocompleteRequest={action:"start",editingSessionId:"edit",requestId:"request",target,query:"exam",cursorPosition:4,preventInlineAutocomplete:false};
const result={protocolVersion:1,hostId:"host",owner:{kind:"session",id:"session"},editingSessionId:"edit",requestId:"request",target,state:"matches",revision:"revision",matches:[
  {id:"history",type:"history",destinationURL:"https://example.com/",fillIntoEdit:"https://example.com/",title:"Example",description:"example.com",inlineAutocompletion:"ple.com",isSearch:false,deletable:true,canBeDefault:false,acceptToken:"accept",deleteToken:"delete"},
  {id:"search",type:"search-what-you-typed",destinationURL:"https://www.google.com/search?q=exam",fillIntoEdit:"exam",title:"exam",inlineAutocompletion:"",isSearch:true,deletable:false,canBeDefault:true,acceptToken:"search-token"},
]} satisfies BrowserAutocompleteResult;
test("autocomplete contract preserves exact owner request target and opaque tokens",()=>{
  expect(parseBrowserAutocompleteRequest(start)).toEqual(start);
  expect(parseBrowserAutocompleteResult(result,"host",{kind:"session",id:"session"},start)).toEqual(result);
  for(const changed of [{...result,hostId:"other"},{...result,requestId:"late"},{...result,target:{...target,targetId:"other"}},{...result,owner:{kind:"draft",id:"session"}},{...result,matches:[result.matches[0],result.matches[0]]}])
    expect(()=>parseBrowserAutocompleteResult(changed,"host",{kind:"session",id:"session"},start)).toThrow();
});
test("autocomplete parser rejects sparse matches extra fields and mismatched lifecycle payloads",()=>{
  const sparse=new Array(1);expect(()=>parseBrowserAutocompleteResult({...result,matches:sparse},"host",{kind:"session",id:"session"},start)).toThrow();
  expect(()=>parseBrowserAutocompleteRequest({...start,extra:true})).toThrow();
  expect(()=>parseBrowserAutocompleteRequest({...start,action:"stop",query:undefined,cursorPosition:undefined,preventInlineAutocomplete:undefined,acceptToken:"unexpected"})).toThrow();
  expect(()=>parseBrowserAutocompleteResult({...result,state:"accepted",matches:result.matches},"host",{kind:"session",id:"session"},start)).toThrow();
});
