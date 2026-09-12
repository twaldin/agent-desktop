import { parseBrowserCreateRequest, type BrowserCreateRequest } from "./browser-create";
import { validBrowserFrameTarget } from "./browser-frame";
import type { BrowserFrameTarget, NativeBrowserTabMetadata } from "./browser";
export interface DraftBrowserContinuationPage { request: BrowserCreateRequest; target: BrowserFrameTarget; backend: NativeBrowserTabMetadata["backend"]; kindTag: NativeBrowserTabMetadata["kindTag"] }
export interface DraftBrowserContinuation { version: 1; owner: { ownerId: string; draftId: string; draftRevision: number }; pages: DraftBrowserContinuationPage[] }
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export function parseDraftBrowserContinuation(value: unknown): DraftBrowserContinuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser continuation.");
  const input=value as Record<string,unknown>, owner=input.owner as Record<string,unknown>;
  if(input.version!==1||Object.keys(input).some(key=>!["version","owner","pages"].includes(key))||!owner||typeof owner!=="object"||Array.isArray(owner)
    ||Object.keys(owner).some(key=>!["ownerId","draftId","draftRevision"].includes(key))||!id(owner.ownerId)||!id(owner.draftId)||!Number.isSafeInteger(owner.draftRevision)||(owner.draftRevision as number)<1
    ||!Array.isArray(input.pages)||input.pages.length<1||input.pages.length>32) throw new Error("Invalid browser continuation owner or pages.");
  const names=new Set<string>(), requests=new Set<string>();
  const pages=input.pages.map(raw=>{if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Invalid browser continuation page.");const page=raw as Record<string,unknown>;
    if(Object.keys(page).some(key=>!["request","target","backend","kindTag"].includes(key))||!validBrowserFrameTarget(page.target)||(page.backend!=="worker"&&page.backend!=="cmux")||!["headless","spawned","connected","relay","cmux"].includes(String(page.kindTag)))throw new Error("Invalid browser continuation page.");
    const request=parseBrowserCreateRequest(page.request),target={...(page.target as BrowserFrameTarget)};if(target.name!==`desktop-${request.requestId}`||names.has(target.name)||requests.has(request.requestId))throw new Error("Duplicate or mismatched browser continuation page.");names.add(target.name);requests.add(request.requestId);
    return{request,target,backend:page.backend as DraftBrowserContinuationPage["backend"],kindTag:page.kindTag as DraftBrowserContinuationPage["kindTag"]};});
  return{version:1,owner:{ownerId:owner.ownerId,draftId:owner.draftId,draftRevision:owner.draftRevision as number},pages};
}
