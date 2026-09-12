import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import { symbolPosition, type SymbolLocation } from "../../../../packages/shared/src/symbol-navigation";
import { WorkspaceService } from "../../../host/src/workspace/service";
import { WorkspaceState } from "./workspace-state";
import { SymbolNavigation, type SymbolEditorSnapshot } from "./symbol-navigation";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(operation => operation())); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "symbol-history-"));
  const source = 'import { first, second } from "./target.js";\nfirst();\nsecond();\n';
  const targetText = 'export function first() {}\nexport function second() {}\n';
  await writeFile(join(cwd, "source.ts"), source); await writeFile(join(cwd, "target.ts"), targetText);
  await writeFile(join(cwd, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"module":"nodenext","moduleResolution":"nodenext"}}');
  const service = new WorkspaceService(cwd), target = { projectId: "symbol-project" }, owners: string[] = [];
  const bridge: Pick<DesktopBridge, "workspaceQuery" | "subscribe" | "command"> = {
    subscribe: () => () => {}, command: async () => { throw new Error("Navigation cannot write files"); },
    workspaceQuery: async (owner, query, hostId) => {
      expect(owner).toEqual(target); expect(hostId).toBe("symbol-owner"); owners.push(hostId!);
      if (query.type === "file.read") return { type: query.type, content: await service.readText(query.path) };
      if (query.type === "file.definitions") return { type: query.type, workspaceIdentity: await service.symbolContext(), result: await service.symbolDefinitions(query.request) };
      if (query.type === "file.symbol-context") return { type: query.type, workspaceIdentity: await service.symbolContext() };
      throw new Error("Unexpected query");
    },
  };
  const data = new WorkspaceState(bridge, "symbol-owner", target, { read: async () => null, write: async () => {} });
  data.restored = true; data.setConnected(true); await data.read("source.ts");
  const navigation = new SymbolNavigation(data), opened: SymbolLocation[] = [];
  cleanup.push(async () => { navigation.cancel(); data.stop(); await rm(cwd, { recursive: true, force: true }); });
  const snapshot = (path: string, offset: number): SymbolEditorSnapshot => {
    const text = data.documents.get(path)!.text, point = symbolPosition(text, offset);
    return { text, selections: [{ start: point, end: point, direction: "forward" }] };
  };
  const open = (location: SymbolLocation) => { opened.push(location); };
  const reveal = () => { const pending = navigation.pending; if (!pending) throw new Error(navigation.message); navigation.revealed(pending.request.id); };
  return { cwd, data, navigation, owners, opened, snapshot, open, reveal, source, targetText };
}

test("history commits only after reveal, restores cursor selections, and new navigation drops the forward branch", async () => {
  const f = await fixture();
  const origin = f.snapshot("source.ts", f.source.indexOf("first();") + 2);
  origin.selections.push({ start: { line: 3, column: 1 }, end: { line: 3, column: 7 }, direction: "backward" });
  await f.navigation.define("source.ts", origin, f.open);
  expect(f.navigation.index).toBe(-1); f.reveal();
  expect(f.opened.at(-1)?.path).toBe("target.ts");
  await f.navigation.travel(-1, "target.ts", f.snapshot("target.ts", 18), f.open);
  expect(f.navigation.pending?.request.selections).toEqual(origin.selections); f.reveal();
  expect(f.navigation.canForward).toBe(true);
  await f.navigation.define("source.ts", f.snapshot("source.ts", f.source.indexOf("second();") + 2), f.open); f.reveal();
  expect(f.opened.at(-1)?.selection.start.line).toBe(2);
  expect(f.navigation.canForward).toBe(false);
  expect(f.data.documents.get("source.ts")?.text).toBe(f.source);
}, 60_000);

test("unrelated dirty JSON does not block definitions, but dirty compiler JSON cannot use stale disk configuration", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "notes.json"), '{"note":"saved"}');
  await writeFile(join(f.cwd, "compiler-extra.json"), '{"compilerOptions":{"strict":false}}');
  await writeFile(join(f.cwd, "tsconfig.json"), '{"extends":"./compiler-extra.json","compilerOptions":{"noLib":true,"module":"nodenext","moduleResolution":"nodenext"}}');
  await f.data.read("notes.json"); await f.data.read("compiler-extra.json");
  f.data.edit("notes.json", '{"note":"unsaved"}');
  await f.navigation.define("source.ts", f.snapshot("source.ts", f.source.indexOf("first();") + 2), f.open);
  expect(f.opened.at(-1)?.path).toBe("target.ts"); f.reveal();
  const index = f.navigation.index, count = f.opened.length;
  f.data.edit("compiler-extra.json", '{"compilerOptions":{"strict":true}}');
  await f.navigation.define("source.ts", f.snapshot("source.ts", f.source.indexOf("first();") + 2), f.open);
  expect(f.opened.length).toBe(count); expect(f.navigation.index).toBe(index);
  expect(f.navigation.message).toContain("compiler-extra.json");
  expect(f.data.documents.get("notes.json")?.text).toBe('{"note":"unsaved"}');
  expect(f.data.documents.get("compiler-extra.json")?.text).toBe('{"compilerOptions":{"strict":true}}');
}, 60_000);

test("modifier-click navigation returns to the clicked token rather than the old caret", async () => {
  const f = await fixture();
  const snapshot = f.snapshot("source.ts", f.source.indexOf("second();") + 2);
  snapshot.position = { line: 2, column: 1 };
  await f.navigation.define("source.ts", snapshot, f.open); f.reveal();
  await f.navigation.travel(-1, "target.ts", f.snapshot("target.ts", 18), f.open);
  expect(f.opened.at(-1)?.path).toBe("source.ts");
  expect(f.navigation.pending?.request.selections).toEqual([{ start: snapshot.position, end: snapshot.position, direction: "forward" }]);
  f.reveal();
}, 60_000);

test("missing and dirty-stale destinations retain buffers and leave the history index unchanged", async () => {
  const f = await fixture();
  await f.navigation.define("source.ts", f.snapshot("source.ts", f.source.indexOf("first();") + 2), f.open); f.reveal();
  await f.navigation.travel(-1, "target.ts", f.snapshot("target.ts", 18), f.open); f.reveal();
  const index = f.navigation.index, count = f.opened.length;
  f.data.edit("target.ts", "// unsaved\n" + f.targetText);
  await f.navigation.travel(1, "source.ts", f.snapshot("source.ts", f.source.indexOf("first();") + 2), f.open);
  expect(f.navigation.index).toBe(index); expect(f.opened.length).toBe(count);
  expect(f.data.documents.get("target.ts")?.text).toBe("// unsaved\n" + f.targetText);
  await rm(join(f.cwd, "target.ts"));
  await f.navigation.travel(1, "source.ts", f.snapshot("source.ts", f.source.indexOf("first();") + 2), f.open);
  expect(f.navigation.index).toBe(index); expect(f.opened.length).toBe(count);
  expect(f.data.documents.get("target.ts")?.dirty).toBe(true);
}, 60_000);

test("foreign-owner and offline history cannot open locations or advance navigation", async () => {
  const f = await fixture();
  await f.navigation.define("source.ts", f.snapshot("source.ts", f.source.indexOf("first();") + 2), f.open); f.reveal();
  const count = f.opened.length, index = f.navigation.index;
  f.navigation.entries[0] = { ...f.navigation.entries[0]!, hostId: "other-owner" };
  await f.navigation.travel(-1, "target.ts", f.snapshot("target.ts", 18), f.open);
  expect(f.navigation.index).toBe(index); expect(f.opened.length).toBe(count);
  f.navigation.entries[0] = { ...f.navigation.entries[0]!, hostId: "symbol-owner", workspaceIdentity: "replaced-workspace" };
  await f.navigation.travel(-1, "target.ts", f.snapshot("target.ts", 18), f.open);
  expect(f.navigation.index).toBe(index); expect(f.opened.length).toBe(count);
  f.data.setConnected(false);
  await f.navigation.travel(-1, "target.ts", f.snapshot("target.ts", 18), f.open);
  expect(f.navigation.index).toBe(index); expect(f.opened.length).toBe(count);
}, 60_000);

test("failed reveal never creates a successful navigation entry", async () => {
  const f = await fixture();
  await f.navigation.define("source.ts", f.snapshot("source.ts", f.source.indexOf("first();") + 2), f.open);
  const id = f.navigation.pending?.request.id; if (!id) throw new Error(f.navigation.message);
  f.navigation.revealed(id, "Target changed before the native editor attached");
  expect(f.navigation.index).toBe(-1); expect(f.navigation.entries).toEqual([]);
}, 60_000);
