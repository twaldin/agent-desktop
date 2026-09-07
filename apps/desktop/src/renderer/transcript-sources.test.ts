import { expect, test } from "bun:test";
import { transcriptSources } from "./transcript-sources";

test("native auto-read sources retain original image indexes and exclude skipped reads", () => {
  const result = transcriptSources([{ id: "file-context", nativeId: "native-file-context", role: "fileMention", text: "", fileReferences: [
    { path: "notes #1.txt", content: "actual snapshot" },
    { path: "large.bin", content: "skipped", skippedReason: "tooLarge" },
    { path: "screen.png", content: "", image: { blockIndex: 2, mimeType: "image/png", bytes: 4, sha256: "a".repeat(64) } },
    { path: "missing.png", content: "", image: { blockIndex: 3, mimeType: "image/png", error: "Unavailable" } },
  ] }], "session");
  expect(result).toEqual([
    { id: "file:notes #1.txt", kind: "file", path: "notes #1.txt", label: "notes #1.txt" },
    { id: "image:native-file-context:2", kind: "image", label: "screen.png", image: { kind: "transcript", sessionId: "session", nativeEntryId: "native-file-context", blockIndex: 2, mimeType: "image/png", bytes: 4, sha256: "a".repeat(64) } },
  ]);
});
import type { TranscriptMessage } from "../../../../packages/shared/src/protocol";

test("source provenance requires a completed successful read or durable image block", () => {
  const proposed:TranscriptMessage = {id:"proposal",role:"assistant",text:"",content:[
    {type:"toolCall",id:"read1",name:"read",arguments:{path:"src/app.ts"}},
    {type:"toolCall",id:"read2",name:"read",arguments:{path:"secret-missing"}},
    {type:"toolCall",id:"write",name:"write",arguments:{path:"output.ts"}},
  ]};
  const result = (id:string,isError?:boolean):TranscriptMessage => ({id:`result-${id}`,role:"toolResult",text:"",tool:{callId:id,status:"completed",isError}});
  expect(transcriptSources([proposed],"session")).toEqual([]);
  expect(transcriptSources([proposed,result("read1"),result("read2",true),result("write",false)],"session")).toEqual([]);
  const images:TranscriptMessage = {id:"display",nativeId:"native",role:"user",text:"",content:[{type:"image",nativeType:"image",blockIndex:2,mimeType:"image/png"}]};
  expect(transcriptSources([proposed,result("read1",false),result("read1",false),images],"session")).toEqual([
    {id:"file:src/app.ts",kind:"file",path:"src/app.ts",label:"src/app.ts"},
    {id:"image:native:2",kind:"image",label:"Recorded image 1",image:{kind:"transcript",sessionId:"session",nativeEntryId:"native",blockIndex:2,mimeType:"image/png",bytes:undefined,sha256:undefined}},
  ]);
  expect(transcriptSources([{...images,nativeId:undefined}],"session")).toEqual([]);
});
