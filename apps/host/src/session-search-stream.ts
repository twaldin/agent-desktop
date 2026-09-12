import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { sessionSearchSnippet, type StoredSessionText } from "./session-search";

/** Decode a journal one JSONL record at a time using the pinned native parser.
 * Retention is one record plus one input chunk, not the complete journal. Like
 * OMP's stream loader, a single very large record can itself require memory. */
export async function searchSessionStream(source: AsyncIterable<Uint8Array>, sessionId: string, query: string,
  signal: AbortSignal, yieldTurn: () => Promise<void> = () => Bun.sleep(0)): Promise<StoredSessionText> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const wanted = query.toLocaleLowerCase("en-US");
  let pending = "", header = "", prefix = "", physicalLine = 0, bytes = 0, records = 0, bytesSinceYield = 0;
  let snippet: string | undefined;
  const visit = (line: string) => {
    signal.throwIfAborted();
    physicalLine++;
    if (!header) {
      if (!line.trim()) return;
      // The native title-slot recognizer requires the physical newline that
      // our record splitter consumed, even when this is the only line so far.
      const loaded = parseSessionContent(prefix + line + "\n");
      const first = loaded.entries[0];
      if (!first && loaded.titleSlot && physicalLine === 1 && !loaded.malformedRecords) { prefix = `${line}\n`; return; }
      if (loaded.invalidHeader || loaded.malformedRecords || first?.type !== "session" || first.id !== sessionId
        || (first.version !== undefined && (!Number.isInteger(first.version) || first.version > CURRENT_SESSION_VERSION))) throw new Error("Stored session cannot be searched completely.");
      header = JSON.stringify(first); prefix = ""; return;
    }
    if (!line.trim()) return;
    const loaded = parseSessionContent(`${header}\n${line}`);
    if (loaded.malformedRecords || loaded.invalidHeader || loaded.entries.length !== 2) throw new Error("Stored session cannot be searched completely.");
    const entry = loaded.entries[1]!;
    // Continue validating the journal after a hit, retaining only its snippet.
    if (snippet !== undefined || entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(block => block.type === "text" && typeof block.text === "string").map(block => (block as { text: string }).text).join("\n") : "";
    if (text.toLocaleLowerCase("en-US").includes(wanted)) snippet = sessionSearchSnippet(text, wanted);
  };
  for await (const chunk of source) {
    signal.throwIfAborted(); bytes += chunk.byteLength; bytesSinceYield += chunk.byteLength;
    pending += decoder.decode(chunk, { stream: true });
    let start = 0, end: number;
    while ((end = pending.indexOf("\n", start)) !== -1) {
      visit(pending.slice(start, end)); start = end + 1;
      if (++records % 256 === 0) { await yieldTurn(); signal.throwIfAborted(); }
    }
    pending = pending.slice(start);
    if (bytesSinceYield >= 1024 * 1024) { bytesSinceYield = 0; await yieldTurn(); signal.throwIfAborted(); }
  }
  pending += decoder.decode();
  if (pending.length) visit(pending);
  signal.throwIfAborted();
  if (!header) throw new Error("Stored session has no valid header.");
  return { bytes, ...(snippet === undefined ? {} : { snippet }) };
}
