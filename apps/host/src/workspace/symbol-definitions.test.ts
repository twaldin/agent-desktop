import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService } from "./service";
import { parseSymbolDefinitionRequest, symbolPosition, type SymbolBuffer, type SymbolDefinitionRequest } from "../../../../packages/shared/src/symbol-navigation";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "symbol-definitions-")); roots.push(root);
  const cwd = join(root, "project"); await mkdir(cwd);
  for (const [path, text] of Object.entries(files)) await writeFile(join(cwd, path), text);
  await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true, allowJs: true, checkJs: true, module: "nodenext", moduleResolution: "nodenext", noEmit: true }, include: ["*.ts", "*.js"] }));
  const service = new WorkspaceService(cwd);
  return { root, cwd, service, async request(path: string, offset: number, buffers: SymbolBuffer[] = []): Promise<SymbolDefinitionRequest> {
    const content = await service.readText(path); if (content.kind !== "text") throw new Error("Expected UTF-8 fixture");
    return { path, revision: content.revision, position: symbolPosition(buffers.find(buffer => buffer.path === path)?.text ?? content.text, offset), buffers, source: "working-tree" };
  } };
}

test("compiler binding distinguishes lexical shadows and ignores identical words in comments and strings", async () => {
  const text = 'const value = 1;\nfunction inner(value: number) { return value; }\nconst sentence = "value"; // value\nvalue;\n';
  const f = await fixture({ "MixedCase.ts": text });
  const local = await f.service.symbolDefinitions(await f.request("MixedCase.ts", text.indexOf("return value") + 8));
  expect(local.status).toBe("definitions");
  if (local.status !== "definitions") throw new Error(JSON.stringify(local));
  expect(local.definitions.map(item => ({ path: item.path, start: item.selection.start }))).toEqual([{ path: "MixedCase.ts", start: { line: 2, column: 16 } }]);
  const comment = await f.service.symbolDefinitions(await f.request("MixedCase.ts", text.indexOf("// value") + 4));
  expect(comment.status).toBe("no-definition");
  const literal = await f.service.symbolDefinitions(await f.request("MixedCase.ts", text.indexOf('"value"') + 2));
  expect(literal.status).toBe("no-definition");
  const outer = await f.service.symbolDefinitions(await f.request("MixedCase.ts", text.lastIndexOf("value") + "value".length));
  expect(outer.status === "definitions" && outer.definitions.map(item => item.selection.start)).toEqual([{ line: 1, column: 7 }]);
}, 60_000);

test("compiler follows renamed imports and overlays unsaved dependencies without writing them", async () => {
  const source = 'import { original as renamed } from "./b.js";\nrenamed();\n', disk = 'export function original() { return 1; }\n';
  const f = await fixture({ "a.ts": source, "b.ts": disk });
  const base = await f.service.readText("b.ts"); if (base.kind !== "text") throw new Error("Expected text");
  const result = await f.service.symbolDefinitions(await f.request("a.ts", source.lastIndexOf("renamed") + 2, [{ path: "b.ts", revision: base.revision, text: "\n\n" + disk }]));
  expect(result.status).toBe("definitions");
  if (result.status !== "definitions") throw new Error(JSON.stringify(result));
  expect(result.definitions.map(item => [item.path, item.selection.start])).toEqual([["b.ts", { line: 3, column: 17 }]]);
  expect(await readFile(join(f.cwd, "b.ts"), "utf8")).toBe(disk);
}, 60_000);

test("merged declarations produce real multiple-definition choices", async () => {
  const text = 'interface Named { a: number }\ninterface Named { b: number }\nlet item: Named;\n';
  const f = await fixture({ "a.ts": text });
  const result = await f.service.symbolDefinitions(await f.request("a.ts", text.lastIndexOf("Named") + 1));
  expect(result.status === "definitions" && result.definitions.map(item => item.selection.start.line)).toEqual([1, 2]);
}, 60_000);

test("1-based UTF-16 locations preserve BOM, CRLF and non-ASCII identifier positions", async () => {
  const text = 'const emoji = "😀"; const café = 1;\r\ncafé;\r\n';
  const f = await fixture({ "a.js": "\uFEFF" + text });
  const result = await f.service.symbolDefinitions(await f.request("a.js", text.lastIndexOf("café") + 1));
  expect(result.status === "definitions" && result.definitions[0]?.selection.start).toEqual(symbolPosition(text, text.indexOf("café")));
}, 60_000);

test("stale revisions and historical contexts never masquerade as current definitions", async () => {
  const f = await fixture({ "a.ts": "const value = 1; value;\n" });
  const request = await f.request("a.ts", 18);
  await writeFile(join(f.cwd, "a.ts"), "const other = 1; other;\n");
  expect((await f.service.symbolDefinitions(request)).status).toBe("stale");
  expect((await f.service.symbolDefinitions({ ...request, source: "historical" })).status).toBe("unsupported");
  expect(() => parseSymbolDefinitionRequest({ ...request, path: "../foreign.ts" })).toThrow();
});

test("outside-owner symlinks cannot supply imported definitions", async () => {
  const source = 'import { secret } from "./foreign.js"; secret;';
  const f = await fixture({ "a.ts": source });
  await writeFile(join(f.root, "foreign.ts"), "export const secret = 1;");
  await symlink(join(f.root, "foreign.ts"), join(f.cwd, "foreign.ts"));
  const result = await f.service.symbolDefinitions(await f.request("a.ts", source.lastIndexOf("secret") + 1));
  expect(result.status).toBe("no-definition");
  expect(await readFile(join(f.root, "foreign.ts"), "utf8")).toBe("export const secret = 1;");
}, 60_000);
