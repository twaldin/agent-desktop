import { expect, test } from "bun:test";
import type { WorkspaceEntry } from "@agent-desktop/shared";
import { fileTreeSearchRows } from "./workspace-file-tree-search";

const file = (path: string): WorkspaceEntry => ({ path, name: path.split("/").at(-1)!, kind: "file", size: 1, mode: 0, modifiedAt: 0 });

test("search builds only matching branches, flattens empty directory chains and deduplicates without sorting host matches", () => {
  const rows = fileTreeSearchRows([
    file("z/deep/needle-z.ts"), file("z/deep/needle-a.ts"), file("z/deep/needle-z.ts"), file("a/needle.ts"), file("root.ts"),
  ], new Set());
  expect(rows.map(row => [row.entry.path, row.entry.name, row.level, row.expanded])).toEqual([
    ["z/deep", "z/deep", 1, true],
    ["z/deep/needle-z.ts", "needle-z.ts", 2, false],
    ["z/deep/needle-a.ts", "needle-a.ts", 2, false],
    ["a", "a", 1, true],
    ["a/needle.ts", "needle.ts", 2, false],
    ["root.ts", "root.ts", 1, false],
  ]);
  expect(rows[1]?.parent).toBe("z/deep");
  expect(fileTreeSearchRows([], new Set())).toEqual([]);
});

test("search collapse affects only its result branch and preserves exact host paths for opening", () => {
  const entries = [file("src/deep/needle.ts"), file("docs/needle.md")];
  const rows = fileTreeSearchRows(entries, new Set(["src/deep"]));
  expect(rows.map(row => row.entry.path)).toEqual(["src/deep", "docs", "docs/needle.md"]);
  expect(rows[0]?.expanded).toBe(false);
  const reopened = fileTreeSearchRows(entries, new Set());
  expect(reopened.filter(row => row.entry.kind === "file").map(row => row.entry.path)).toEqual(entries.map(entry => entry.path));
});
