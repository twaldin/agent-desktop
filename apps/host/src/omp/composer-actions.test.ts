import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession, Extension } from "@oh-my-pi/pi-coding-agent";
import { builtinAvailability, composerCompletions, hasNativeTodoComposerWinner, sessionComposerActions, type NativeComposerCatalog } from "./composer-actions";

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

test("native context maintenance exposes every headless compact and shake mode", () => {
  const session = { mcpPromptCommands: [], customCommands: [], slashCommands: [], promptTemplates: [], skills: [], skillWarnings: [],
    sessionManager: { getCwd: () => "/fixture" } } as unknown as AgentSession;
  const native = sessionComposerActions(session, []);
  const compact = native.commands.find(row => row.id === "builtin:compact");
  const shake = native.commands.find(row => row.id === "builtin:shake");
  expect(compact).toMatchObject({ availability: "executable", argumentHint: "[soft|remote|snapcompact] [focus]" });
  expect(compact?.subcommands?.map(sub => [sub.name, sub.availability])).toEqual([
    ["soft", "executable"], ["remote", "executable"], ["snapcompact", "executable"],
  ]);
  expect(shake).toMatchObject({ availability: "executable", argumentHint: "[elide|images|thinking]" });
  expect(shake?.subcommands?.map(sub => [sub.name, sub.availability])).toEqual([
    ["elide", "executable"], ["images", "executable"], ["thinking", "executable"],
  ]);
  for (const name of ["compact", "shake"]) {
    const extension = { resolvedPath: `/fixture/${name}.ts`, label: "shadow", commands: new Map([[name, { name, description: "replacement", handler: async () => {} }]]) } as unknown as Extension;
    expect(sessionComposerActions(session, [extension]).commands.find(row => row.id === `builtin:${name}`)?.availability).toBe("shadowed");
  }
});

test("native handoff is executable only while extension and custom precedence leave it in control", () => {
  const session = { mcpPromptCommands: [], customCommands: [], slashCommands: [], promptTemplates: [], skills: [], skillWarnings: [],
    sessionManager: { getCwd: () => "/fixture" } } as unknown as AgentSession;
  const availability = (extensions: Extension[] = []) => sessionComposerActions(session, extensions).commands.find(row => row.id === "builtin:handoff")?.availability;
  expect(availability()).toBe("executable");
  const extension = { resolvedPath: "/fixture/handoff.ts", commands: new Map([
    ["handoff", { name: "handoff", description: "Extension handoff", handler: async () => {} }],
  ]) } as unknown as Extension;
  expect(availability([extension])).toBe("shadowed");
  Object.assign(session, { customCommands: [{ resolvedPath: "/fixture/custom.ts", source: "project",
    command: { name: "handoff", description: "Custom handoff", execute: async () => undefined } }] });
  expect(availability()).toBe("shadowed");
  for (const name of ["new", "clear", "resume", "move", "quit"])
    expect(builtinAvailability(name).availability).toBe("pending");
});

test("the session catalog exposes native pin without admitting native deletion", () => {
  const session = { mcpPromptCommands: [], customCommands: [], slashCommands: [], promptTemplates: [], skills: [], skillWarnings: [],
    sessionManager: { getCwd: () => "/fixture" } } as unknown as AgentSession;
  const row = sessionComposerActions(session, []).commands.find(row => row.id === "builtin:session");
  expect(row?.availability).toBe("partial");
  expect(row?.subcommands?.map(sub => [sub.name, sub.availability])).toEqual([
    ["info", "executable"], ["delete", "pending"], ["pin", "executable"],
  ]);
});

test("session admission preserves native verb parsing and the full pin selector remainder", () => {
  expect(builtinAvailability("session", " \tPiN\tOrganization With  Spaces ").availability).toBe("executable");
  expect(builtinAvailability("session", "pin\nOAuth credential #12").availability).toBe("executable");
  expect(builtinAvailability("session", " INFO \t").availability).toBe("executable");
  expect(builtinAvailability("session", "info extra").availability).toBe("pending");
  expect(builtinAvailability("session", "pinning account").availability).toBe("pending");
  expect(builtinAvailability("session", "DELETE").availability).toBe("pending");
});

test("native plugin maintenance exposes reload and explicit plugin mutations only", () => {
  const session = { mcpPromptCommands: [], customCommands: [], slashCommands: [], promptTemplates: [], skills: [], skillWarnings: [],
    sessionManager: { getCwd: () => "/fixture" } } as unknown as AgentSession;
  const native = sessionComposerActions(session, []);
  expect(native.commands.find(row => row.id === "builtin:reload-plugins")).toMatchObject({ availability: "executable" });
  const plugins = native.commands.find(row => row.id === "builtin:plugins");
  expect(plugins).toMatchObject({ availability: "executable" });
  expect(plugins?.subcommands?.map(sub => [sub.name, sub.availability])).toEqual([
    ["list", "executable"], ["enable", "executable"], ["disable", "executable"],
  ]);
  const extension = { resolvedPath: "/fixture/plugins.ts", label: "shadow", commands: new Map([
    ["plugins", { name: "plugins", description: "replacement", handler: async () => {} }],
    ["reload-plugins", { name: "reload-plugins", description: "replacement", handler: async () => {} }],
  ]) } as unknown as Extension;
  const shadowed = sessionComposerActions(session, [extension]);
  expect(shadowed.commands.find(row => row.id === "builtin:plugins")?.availability).toBe("shadowed");
  expect(shadowed.commands.find(row => row.id === "builtin:reload-plugins")?.availability).toBe("shadowed");
});
