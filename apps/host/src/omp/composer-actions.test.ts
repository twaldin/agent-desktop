import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composerCompletions, type NativeComposerCatalog } from "./composer-actions";

test("native file completions expose owner absolute paths only for regular files", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agent-desktop-composer-path-"));
  try {
    const quotedFile = path.join(cwd, "file with spaces.txt");
    const relativeFile = path.join(cwd, "relative-file.txt");
    await Promise.all([writeFile(quotedFile, "owner only"), writeFile(relativeFile, "owner only"), mkdir(path.join(cwd, "folder with spaces"))]);
    const catalog: NativeComposerCatalog = { protocolVersion: 1, cwd, revision: "fixture", commands: [], skills: [], referenceSchemes: [], diagnostics: [] };

    const quoted = await composerCompletions(catalog, { kind: "file", query: "file" });
    expect(quoted.items.find(item => item.label === "file with spaces.txt")).toMatchObject({ insertText: '@"file with spaces.txt" ', path: quotedFile });

    const relative = await composerCompletions(catalog, { kind: "file", query: "relative" });
    expect(relative.items.find(item => item.label === "relative-file.txt")).toMatchObject({ insertText: "@relative-file.txt ", path: relativeFile });

    const directory = await composerCompletions(catalog, { kind: "file", query: "folder" });
    expect(directory.items.find(item => item.label === "folder with spaces/")).toMatchObject({ insertText: '@"folder with spaces/ ', kind: "directory-reference" });
    expect(directory.items.find(item => item.label === "folder with spaces/")?.path).toBeUndefined();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
