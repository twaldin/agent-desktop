import { describe, expect, test } from "bun:test";
import type { ComposerAction, ComposerActionsCatalog } from "../../../../packages/shared/src/composer-actions";
import { assertComposerOwner, catalogSuggestions, composerToken, nextSuggestion, replaceComposerToken } from "./composer-autocomplete";

const action: ComposerAction = { id: "mode", name: "mode", aliases: ["m"], description: "Set mode", insertText: "/mode ", source: { kind: "builtin", label: "OMP" }, availability: "executable", argumentCompletions: true };
const catalog: ComposerActionsCatalog = { protocolVersion: 1, hostId: "home", target: { sessionId: "one" }, cwd: "/project", revision: "1", referenceSchemes: ["skill", "local"], commands: [action], skills: [{ ...action, id: "skill", name: "review", insertText: "/skill:review ", source: { kind: "skill", label: "Personal" } }], diagnostics: [] };
const token = (text: string) => composerToken(text, text.length, text.length, catalog);

describe("composer completion boundaries and native insertion", () => {
  test("distinguishes leading commands, skills and file references from literal text", () => {
    expect(token("  /mo")?.kind).toBe("command");
    expect(replaceComposerToken("  /mo", token("  /mo")!, "/mode ").text).toBe("/mode ");
    expect(token("please use $rev")?.kind).toBe("skill");
    expect(token("inspect (@src")?.kind).toBe("file");
    for (const text of ["hello@example.com", "https://example.com/a", "use /usr/bin", "\\$literal", "`$literal", "```\n@literal", "a@$name"]) expect(token(text)).toBeUndefined();
    expect(composerToken("$skill", 1, 3)).toBeUndefined();
  });
  test("replaces the whole selected word but preserves surrounding prompt", () => {
    const text = "Read @sourcestale then explain";
    const selected = composerToken(text, 8)!;
    expect(replaceComposerToken(text, selected, '@"source file.ts" ')).toEqual({ text: 'Read @"source file.ts" then explain', caret: 22 });
  });
  test("quoted paths with spaces remain a single reference", () => {
    const text = 'Read @"source fiZZ" next';
    const selected = composerToken(text, text.indexOf("ZZ"))!;
    expect(selected.query).toBe('"source fi');
    expect(replaceComposerToken(text, selected, '@"source file.ts" ').text).toBe('Read @"source file.ts" next');
  });
  test("uses the host registry for native URI completions", () => {
    expect(token("see skill://rev")).toMatchObject({ kind: "reference", query: "skill://rev" });
    expect(token("local:/src")).toMatchObject({ kind: "reference", query: "local:/src" });
    expect(token("https://example.com")).toBeUndefined();
    expect(token("unregistered://anything")).toBeUndefined();
  });
  test("native argument callbacks replace the argument prefix, retaining the suffix", () => {
    const text = "/m edit tail";
    const selected = composerToken(text, 7, 7, catalog)!;
    expect(selected).toMatchObject({ kind: "command-argument", commandName: "m", query: "edit", start: 3, end: 7 });
    expect(replaceComposerToken(text, selected, "plan").text).toBe("/m plan tail");
    expect(token("/unknown args")).toBeUndefined();
    expect(token("/mode ")?.query).toBe("");
  });
  test("skills use native invocation and reject invalid native nesting", () => {
    const text = "Please $rev";
    const items = catalogSuggestions(catalog, token(text)!, text, []);
    expect(items[0]!.insertText).toBe("/skill:review ");
    expect(items[0]!.disabled).toBeUndefined();
    const nested = "/other $rev";
    expect(catalogSuggestions(catalog, token(nested)!, nested, [])[0]!.disabled).toContain("nested");
    const second = "/skill:first $rev";
    expect(catalogSuggestions(catalog, token(second)!, second, [])[0]!.disabled).toContain("first skill");
  });
  test("app actions do not hide native collisions; unavailable commands stay explicit", () => {
    const entries = catalogSuggestions({ ...catalog, commands: [action, { ...action, id: "blocked", name: "blocked", availability: "pending", reason: "Needs native UI" }] }, token("/")!, "/", [{ id: "mode", name: "Mode", description: "App action", icon: "more", run() {} }]);
    expect(entries.map(item => item.id)).toEqual(["app:mode", "native:mode", "native:blocked"]);
    expect(entries[2]!.disabled).toBe("Needs native UI");
    expect(nextSuggestion(entries, "native:mode", 1)).toBe("app:mode");
    expect(nextSuggestion(entries, "app:mode", -1)).toBe("native:mode");
  });
  test("rejects old or foreign completion catalogs", () => {
    expect(() => assertComposerOwner(catalog, "home", { sessionId: "one" })).not.toThrow();
    expect(() => assertComposerOwner(catalog, "work", { sessionId: "one" })).toThrow("different host");
    expect(() => assertComposerOwner(catalog, "home", { projectId: "one" })).toThrow("different host");
    expect(() => assertComposerOwner(null, "home")).toThrow("Update the owning host");
  });
});
