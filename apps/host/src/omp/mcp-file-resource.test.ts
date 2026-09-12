import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, symlink, unlink } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpFileResources, MCP_VIEWER_MAX_BYTES } from "./mcp-file-resource";
import type { McpJson } from "../../../../packages/shared/src/session-mcp-app";
const source = { type: "file" as const, path: "report.bin", resourceUri: "codex-resource://original" };
type Read = { contents: Array<{ blob?: string; text?: string }>; _meta: { "openai/resource": { etag: string; writable: boolean } } };
async function fixture(work: (owner: McpFileResources, cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "artifact-resource-"));
  try { await writeFile(join(cwd, source.path), Buffer.from([1, 0, 255])); await work(new McpFileResources(cwd), cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}
test("original file bytes and revision survive viewer reads; stale writes conflict, refreshed binary writes save exact bytes", () => fixture(async (owner, cwd) => {
  const signal = new AbortController().signal, current = () => {};
  const read = await owner.request(source, "resources/read", { uri: source.resourceUri }, signal, current) as Read;
  expect(read.contents).toMatchObject([{ blob: "AQD/" }]); expect(read._meta["openai/resource"].writable).toBe(true);
  await writeFile(join(cwd, source.path), "external");
  const conflict = await owner.request(source, "openai/resources/write", { uri: source.resourceUri, blob: "AgAB", ifMatch: read._meta["openai/resource"].etag }, signal, current) as { outcome: string; etag: string };
  expect(conflict.outcome).toBe("conflict"); expect(await readFile(join(cwd, source.path), "utf8")).toBe("external");
  expect(await owner.request(source, "openai/resources/write", { uri: `${source.resourceUri}/render`, blob: "AgAB", ifMatch: conflict.etag }, signal, current)).toMatchObject({ outcome: "saved" });
  expect(await readFile(join(cwd, source.path))).toEqual(Buffer.from([2, 0, 1]));
}));
test("foreign URIs, malformed bytes, missing revision, and oversized writes cannot change the original file", () => fixture(async (owner, cwd) => {
  const signal = new AbortController().signal, current = () => {}, before = await readFile(join(cwd, source.path));
  const read = await owner.request(source, "resources/read", { uri: source.resourceUri }, signal, current) as Read;
  const params = { uri: source.resourceUri, ifMatch: read._meta["openai/resource"].etag, text: "new" };
  for (const value of [{ ...params, uri: "codex-resource://other" }, { ...params, ifMatch: undefined }, { ...params, blob: "AA==" }, { uri: params.uri, ifMatch: params.ifMatch, blob: "@@" }]) {
    await expect(owner.request(source, "openai/resources/write", value as unknown as Record<string, McpJson>, signal, current)).rejects.toThrow();
  }
  expect(await owner.request(source, "openai/resources/write", { ...params, text: "x".repeat(MCP_VIEWER_MAX_BYTES + 1) }, signal, current)).toEqual({ outcome: "too-large", maxBytes: MCP_VIEWER_MAX_BYTES });
  expect(await readFile(join(cwd, source.path))).toEqual(before);
}));
test("retirement at the final save admission leaves original bytes and drains the temporary file", () => fixture(async (owner, cwd) => {
  const signal = new AbortController().signal, before = await readFile(join(cwd, source.path));
  const read = await owner.request(source, "resources/read", { uri: source.resourceUri }, signal, () => {}) as Read;
  await expect(owner.request(source, "openai/resources/write", { uri: source.resourceUri, text: "replacement", ifMatch: read._meta["openai/resource"].etag }, signal, () => { if (readdirSync(cwd).some(name => name.startsWith(".agent-desktop-save-"))) throw new Error("Original document retired"); })).rejects.toThrow("Original document retired");
  expect(await readFile(join(cwd, source.path))).toEqual(before);
  const { readdir } = await import("node:fs/promises"); expect(await readdir(cwd)).toEqual([source.path]);
}));

test("a viewer cannot save through an original symlink retargeted to different bytes since its last read", () => fixture(async (owner, cwd) => {
  const signal = new AbortController().signal;
  await writeFile(join(cwd, "other.bin"), "different file");
  await symlink(source.path, join(cwd, "selected.bin"));
  const selected = { ...source, path: "selected.bin" };
  const read = await owner.request(selected, "resources/read", { uri: source.resourceUri }, signal, () => {}) as Read;
  await unlink(join(cwd, "selected.bin")); await symlink("other.bin", join(cwd, "selected.bin"));
  expect(await owner.request(selected, "openai/resources/write", { uri: source.resourceUri, ifMatch: read._meta["openai/resource"].etag, text: "stale" }, signal, () => {})).toMatchObject({ outcome: "conflict" });
  expect(await readFile(join(cwd, "other.bin"), "utf8")).toBe("different file");
  expect(await readFile(join(cwd, source.path))).toEqual(Buffer.from([1, 0, 255]));
}));

test("a file subscription observes real edits, deletion and recreation, then releases before later edits", () => fixture(async (owner, cwd) => {
  const abort = new AbortController(); let updates = 0;
  const lease = await owner.watch(source, () => { updates++; }, abort.signal, () => {});
  const changed = async (work: () => Promise<void>) => {
    const before = updates; await work();
    for (let index = 0; index < 200 && updates === before; index++) await Bun.sleep(10);
    expect(updates).toBeGreaterThan(before);
  };
  try {
    await changed(() => writeFile(join(cwd, source.path), "external edit"));
    const read = await owner.request(source, "resources/read", { uri: source.resourceUri }, abort.signal, () => {}) as Read;
    expect(read.contents[0]?.text).toBe("external edit");
    await changed(() => unlink(join(cwd, source.path)));
    await expect(owner.request(source, "resources/read", { uri: source.resourceUri }, abort.signal, () => {})).rejects.toThrow();
    await changed(() => writeFile(join(cwd, source.path), "replacement"));
    await lease.release(); const afterClose = updates;
    await writeFile(join(cwd, source.path), "after release"); await Bun.sleep(40);
    expect(updates).toBe(afterClose);
  } finally { abort.abort(); await lease.release(); }
}));
test("file subscription cannot acquire a foreign root and abort joins original watcher cleanup", () => fixture(async (owner, cwd) => {
  const abort = new AbortController(); let updates = 0;
  await expect(owner.watch({ ...source, path: "../foreign.bin" }, () => {}, abort.signal, () => {})).rejects.toThrow();
  const lease = await owner.watch(source, () => { updates++; }, abort.signal, () => {});
  abort.abort(); await lease.release();
  const before = updates; await writeFile(join(cwd, source.path), "after abort"); await Bun.sleep(40);
  expect(updates).toBe(before);
}));

test("an edit between original metadata capture and watcher installation is not adopted as an unchanged baseline", () => fixture(async (owner, cwd) => {
  const readMetadata = owner.workspace.copyInfo.bind(owner.workspace); let first = true, updates = 0;
  owner.workspace.copyInfo = async path => {
    const captured = await readMetadata(path);
    if (first) { first = false; await writeFile(join(cwd, source.path), "changed before watch installed"); }
    return captured;
  };
  const abort = new AbortController(), lease = await owner.watch(source, () => { updates++; }, abort.signal, () => {});
  try {
    for (let index = 0; index < 200 && !updates; index++) await Bun.sleep(10);
    expect(updates).toBeGreaterThan(0);
    const current = await owner.request(source, "resources/read", { uri: source.resourceUri }, abort.signal, () => {}) as Read;
    expect(current.contents[0]?.text).toBe("changed before watch installed");
  } finally { abort.abort(); await lease.release(); }
}));
