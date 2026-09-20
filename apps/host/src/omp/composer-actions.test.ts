import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, Extension } from "@oh-my-pi/pi-coding-agent";
import { composerCompletions, hasNativeTodoComposerWinner, sessionComposerActions, type NativeComposerCatalog } from "./composer-actions";

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

test("the native /todo row advertises the desktop Todos route only while it is the exact dispatch winner", () => {
  const session = { mcpPromptCommands: [], customCommands: [], slashCommands: [], promptTemplates: [], skills: [], skillWarnings: [],
    sessionManager: { getCwd: () => "/fixture" } } as unknown as AgentSession;
  const native = sessionComposerActions(session, []);
  const row = native.commands.find(row => row.id === "builtin:todo");
  expect(row).toMatchObject({ availability: "executable", desktopAction: "todos" });
  expect(row?.subcommands?.map(sub => [sub.name, sub.availability])).toEqual(expect.arrayContaining([["edit", "partial"], ["expand", "partial"], ["collapse", "partial"], ["copy", "executable"], ["append", "executable"], ["rm", "executable"]]));
  expect(hasNativeTodoComposerWinner(native)).toBe(true);
  const shadow = { resolvedPath: "/fixture/todo.ts", label: "shadow", commands: new Map([["todo", { name: "todo", description: "replacement", handler: async () => {} }]]) } as unknown as Extension;
  const shadowed = sessionComposerActions(session, [shadow]);
  expect(shadowed.commands.find(row => row.id === "builtin:todo")?.availability).toBe("shadowed");
  expect(hasNativeTodoComposerWinner(shadowed)).toBe(false);
});

test("the native /usage row keeps show executable and exposes only reset as a desktop confirmation route", () => {
  const session = { mcpPromptCommands: [], customCommands: [], slashCommands: [], promptTemplates: [], skills: [], skillWarnings: [],
    sessionManager: { getCwd: () => "/fixture" } } as unknown as AgentSession;
  const native = sessionComposerActions(session, []);
  const row = native.commands.find(row => row.id === "builtin:usage");
  expect(row).toMatchObject({ availability: "executable", desktopAction: "usage-reset" });
  expect(row?.subcommands?.map(sub => [sub.name, sub.availability])).toEqual(expect.arrayContaining([["show", "executable"], ["reset", "partial"]]));
  const shadow = { resolvedPath: "/fixture/usage.ts", label: "shadow", commands: new Map([["usage", { name: "usage", description: "replacement", handler: async () => {} }]]) } as unknown as Extension;
  const shadowed = sessionComposerActions(session, [shadow]);
  expect(shadowed.commands.find(value => value.id === "builtin:usage")?.availability).toBe("shadowed");
});
