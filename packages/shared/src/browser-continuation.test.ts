import { expect,test } from "bun:test";
import { parseDraftBrowserContinuation } from "./browser-continuation";
import type { DraftBrowserContinuation } from "./browser-continuation";
const value:DraftBrowserContinuation={version:1,owner:{ownerId:"owner",draftId:"draft",draftRevision:1},pages:[{request:{requestId:"one",controlEpoch:"epoch",observedAt:1},target:{workerPid:2,name:"desktop-one",targetId:"target"},backend:"worker",kindTag:"headless"}]};
test("browser continuation parser preserves exact bounded native identity",()=>{expect(parseDraftBrowserContinuation(value)).toEqual(value);for(const bad of [{...value,pages:[]},{...value,pages:[...value.pages,...value.pages]},{...value,pages:[{...value.pages[0],target:{...value.pages[0].target,name:"other"}}]}])expect(()=>parseDraftBrowserContinuation(bad)).toThrow();});
