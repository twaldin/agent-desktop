import { describe, expect, test } from "bun:test";
import type { GitStatusEntry } from "../../../../packages/shared/src/workspace";
import { parseReviewPatch, readReviewOptions, reviewEntries, reviewPath } from "./review-model";

describe("review patch model", () => {
  test("uses Pierre metadata for CRLF and no-newline hunk totals", () => {
    const patch = [
      "diff --git a/sample.ts b/sample.ts\r",
      "index 1111111..2222222 100644\r",
      "--- a/sample.ts\r",
      "+++ b/sample.ts\r",
      "@@ -1,2 +1,2 @@\r",
      "-const old = 1;\r",
      "+const next = 2;\r",
      " unchanged\r",
      "\\ No newline at end of file\r",
    ].join("\n");
    const result = parseReviewPatch(patch, "crlf");
    expect(result).toMatchObject({ additions: 1, deletions: 1, binaryFiles: 0 });
    expect(result.files[0]?.metadata.name).toBe("sample.ts");
  });

  test("decodes Git quoted paths and keeps a rename's previous path", () => {
    const patch = [
      "diff --git \"a/old name.ts\" \"b/new name.ts\"",
      "similarity index 75%",
      "rename from old name.ts",
      "rename to new name.ts",
      "index 1111111..2222222 100644",
      "--- \"a/old name.ts\"",
      "+++ \"b/new name.ts\"",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const result = parseReviewPatch(patch, "rename");
    expect(result.files[0]).toMatchObject({ additions: 1, deletions: 1, metadata: { name: "new name.ts", prevName: "old name.ts" } });
    expect(reviewPath("quoted\\040name.ts")).toBe("quoted name.ts");
    // Git quotes rename metadata; the parser keeps that outer pair while a literal quote arrives escaped.
    const quoted = parseReviewPatch(["diff --git \"a/f\\303\\266o \\\"q\\\".txt\" \"b/dir/f\\303\\266o \\\"q\\\".txt\"", "similarity index 90%", "rename from \"f\\303\\266o \\\"q\\\".txt\"", "rename to \"dir/f\\303\\266o \\\"q\\\".txt\"", "index 1111111..2222222 100644", "--- \"a/f\\303\\266o \\\"q\\\".txt\"", "+++ \"b/dir/f\\303\\266o \\\"q\\\".txt\"", "@@ -1 +1 @@", "-a", "+b"].join("\n"), "quoted-rename");
    expect(quoted.files[0]?.metadata).toMatchObject({ name: "dir/föo \"q\".txt", prevName: "föo \"q\".txt" });
  });

  test("reports binary changes without inventing changed-line counts", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const result = parseReviewPatch(patch, "binary");
    expect(result).toMatchObject({ additions: 0, deletions: 0, binaryFiles: 1 });
  });

  test("only accepts validated persisted controls and classifies real status sources", () => {
    expect(() => readReviewOptions('{"split":true,"wrap":"no","lineNumbers":false}')).toThrow("Review preferences are invalid.");
    const entries: GitStatusEntry[] = [
      { path: "staged.ts", indexStatus: "M", worktreeStatus: ".", kind: "tracked", submodule: false },
      { path: "unstaged.ts", indexStatus: ".", worktreeStatus: "M", kind: "tracked", submodule: false },
      { path: "new.ts", indexStatus: "?", worktreeStatus: "?", kind: "untracked", submodule: false },
    ];
    expect(reviewEntries(entries, true).map(entry => entry.path)).toEqual(["staged.ts"]);
    expect(reviewEntries(entries, false).map(entry => entry.path)).toEqual(["unstaged.ts", "new.ts"]);
  });
});
