import { expect, test } from "bun:test";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import { TranscriptMirror } from "./transcript";
test("actual native summary factories retain text and display metadata without exposing provider replay payloads", () => {
 const branch = createBranchSummaryMessage("Exact branch summary", "original-leaf", "2026-09-20T00:00:00Z");
 const compaction = createCompactionSummaryMessage("Exact compacted summary", 2345, "2026-09-20T00:01:00Z", { shortSummary: "Short", method: "soft", tokensAfter: 456, warning: "Native warning" });
 const originals = JSON.stringify([branch, compaction]);
 const rows = new TranscriptMirror().snapshot([branch, compaction], []);
 expect(rows.map(row => row.text)).toEqual([branch.summary, compaction.summary]);
 expect(rows[0]?.nativeSummary).toEqual({ fromId: "original-leaf" });
 expect(rows[1]?.nativeSummary).toMatchObject({ shortSummary: "Short", method: "soft", tokensBefore: 2345, tokensAfter: 456, warning: "Native warning" });
 expect(JSON.stringify([branch, compaction])).toBe(originals);
 const ordinary = new TranscriptMirror().snapshot([{ ...branch, content: "Authoritative ordinary content" }, { ...branch, output: "Authoritative ordinary output" }, { role: "unknown", summary: "Do not invent a known summary role" }], []);
 expect(ordinary.map(row => row.text)).toEqual(["Authoritative ordinary content", "Authoritative ordinary output", ""]);
});
