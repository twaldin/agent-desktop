import type { TranscriptMessage } from "../../../../packages/shared/src/protocol";
import type { AttachmentMediaSource } from "./attachment-media";
export type RecordedSource = {id:string;label:string;kind:"file";path:string} | {id:string;label:string;kind:"image";image:AttachmentMediaSource};
/** Only recorded image blocks and successful native read results establish a
 * source here. A tool proposal, directory listing, or failed read does not. */
export function transcriptSources(messages: readonly TranscriptMessage[], sessionId: string): RecordedSource[] {
  const calls = new Map<string,{name:string;arguments:Record<string,unknown>}>();
  const sources = new Map<string,RecordedSource>();
  for(const message of messages) {
    for(const block of message.content ?? []) {
      if(block.type === "toolCall") calls.set(block.id,block);
      if(block.type === "image" && message.nativeId) {
        const id = `image:${message.nativeId}:${block.blockIndex}`;
        sources.set(id,{id,kind:"image",label:`Recorded image ${[...sources.values()].filter(source => source.kind === "image").length + 1}`,image:{kind:"transcript",sessionId,nativeEntryId:message.nativeId,blockIndex:block.blockIndex,mimeType:block.mimeType,bytes:block.bytes,sha256:block.sha256}});
      }
    }
    const result = message.tool;
    if(!result || result.status !== "completed" || result.isError !== false) continue;
    const call = calls.get(result.callId), name = result.name ?? call?.name, args = result.arguments ?? call?.arguments;
    if(name !== "read" || typeof args?.path !== "string" || !args.path || args.path.includes("\0")) continue;
    const path = args.path, id = `file:${path}`;
    sources.set(id,{id,kind:"file",path,label:path});
  }
  return [...sources.values()];
}
