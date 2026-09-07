import { expect, test } from "bun:test";
import { EditorState, Transaction } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";
import { applyMarkdownChanges, markdownMetadata, markdownTextChange, normalizeMarkdown, protectMarkdownPrefix } from "./markdown-file-model";

test("metadata preview does not consume unsupported or unfinished YAML", () => {
  for (const text of ["---\nname: unfinished", "---\nname: ok\nnested:\n  key: value\n---\nbody", "---\nname: ok\ndescription: |\n  multiline\n---\nbody", "---\nname: first\nname: second\n---\nbody"])
    expect(markdownMetadata(text)).toBeUndefined();
  const raw="---\nname: 'It''s a skill'\nlabels: [one, two]\nitems:\n  - \"three\"\n---\n# Body\n";
  const metadata=markdownMetadata(raw)!;
  expect(metadata.entries).toEqual([{key:"name",value:"It's a skill"},{key:"labels",value:["one","two"]},{key:"items",value:["three"]}]);
  expect(raw.slice(metadata.end)).toBe("# Body\n");
});

test("editing normalized text preserves untouched CRLF, CR, LF, and UTF-16 offsets", () => {
  const raw="# 😀 Title\r\n\r\nold\rsecond\nthird\r\n";
  const normalized=normalizeMarkdown(raw), from=normalized.indexOf("old");
  expect(applyMarkdownChanges(raw,[{from,to:from+3,insert:"new\nline"}])).toBe("# 😀 Title\r\n\r\nnew\r\nline\rsecond\nthird\r\n");
  const result=applyMarkdownChanges(raw,[{from:0,to:1,insert:"##"},{from:normalized.length,to:normalized.length,insert:"tail\n"}]);
  expect(result).toBe("## 😀 Title\r\n\r\nold\rsecond\nthird\r\ntail\r\n");
  expect(applyMarkdownChanges(raw,[])).toBe(raw);
});

test("replacing every normalized character does not leave CR bytes behind", () => {
  const raw="one\rtwo\rthree\r";
  expect(applyMarkdownChanges(raw,[{from:0,to:normalizeMarkdown(raw).length,insert:"replacement\n"}])).toBe("replacement\r");
});

test("rich replacement and boundary deletion cannot remove a hidden metadata prefix", () => {
  const raw="---\r\nname: Keep me\r\n---\r\n# Body\r\n", text=normalizeMarkdown(raw), end=markdownMetadata(text)!.end;
  expect(applyMarkdownChanges(raw,protectMarkdownPrefix([{from:0,to:text.length,insert:"New body\n"}],end))).toBe("---\r\nname: Keep me\r\n---\r\nNew body\r\n");
  expect(applyMarkdownChanges(raw,protectMarkdownPrefix([{from:end-1,to:end,insert:""}],end))).toBe(raw);
  expect(applyMarkdownChanges(raw,protectMarkdownPrefix([{from:0,to:0,insert:"Start "}],end))).toBe("---\r\nname: Keep me\r\n---\r\nStart # Body\r\n");
});

test("external updates retain the unchanged prefix and suffix for selection/history mapping", () => {
  const before="---\nname: keep\n---\nFirst paragraph.\nLast paragraph.\n", after=before.replace("Last","Final");
  const change=markdownTextChange(before,after);
  expect(change.from).toBe(before.indexOf("Last"));
  expect(change.to).toBe(before.indexOf("Last")+4);
  expect(before.slice(0,change.from)+change.insert+before.slice(change.to)).toBe(after);
});

test("a non-overlapping source update preserves rich undo and its external text", () => {
  let state=EditorState.create({doc:"First paragraph.\nLast paragraph.\n",extensions:[history()]});
  state=state.update({changes:{from:0,insert:"Rich "},annotations:Transaction.userEvent.of("input")}).state;
  const next=state.doc.toString().replace("Last","Source");
  state=state.update({changes:markdownTextChange(state.doc.toString(),next),annotations:Transaction.addToHistory.of(false)}).state;
  expect(undoDepth(state)).toBe(1);
  expect(undo({state,dispatch:transaction=>{state=transaction.state;}})).toBe(true);
  expect(state.doc.toString()).toBe("First paragraph.\nSource paragraph.\n");
});
