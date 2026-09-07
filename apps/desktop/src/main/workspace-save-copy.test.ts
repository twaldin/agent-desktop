import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService } from "../../../host/src/workspace/service";
import type { WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { saveWorkspaceCopy, workspaceCopySource, workspaceCopyDefaultName, workspaceCopyOutcome, type WorkspaceCopySource } from "./workspace-save-copy";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, {recursive: true, force: true}))); });
async function fixture(bytes = Buffer.from("\ufeffFirst\r\nSecond\rThird\n")) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-save-copy-"))); roots.push(root);
  const file = join(root, "source.bin"), destination = join(root, "copy.bin");
  await writeFile(file, bytes);
  const service = new WorkspaceService(root), calls: WorkspaceQuery[] = [];
  const source: WorkspaceCopySource = {local: false, query: async query => {
    calls.push(query);
    if (query.type === "file.copy-info") return {type: query.type, path: query.path, ...await service.copyInfo(query.path)};
    if (query.type === "file.copy-chunk") return {type: query.type, path: query.path, ...await service.copyChunk(query.path, query.revision, query.offset)};
    throw new Error("Unexpected query");
  }};
  const input = {target: {projectId: "project"}, path: "source.bin", hostId: "host"};
  return {root, file, destination, source, service, calls, input, bytes};
}
test("native cancellation never resolves the host or reads source", async () => {
  let lookups = 0; const names: string[] = [];
  expect(await saveWorkspaceCopy({target: {projectId: "owner"}, path: "dir/file.txt", hostId: "remote"}, {
    choose: async name => { names.push(name); return null; }, source: async () => { lookups++; throw new Error("must not run"); },
  })).toEqual({path: null});
  expect(names).toEqual(["file.txt"]); expect(lookups).toBe(0);
});
test("default destination name follows the native filename sanitization", () => {
  expect(workspaceCopyDefaultName('src/a:b?*.txt')).toBe('a_b__.txt');
  expect(workspaceCopyDefaultName('/')).toBe('download');
});
test("copy IPC outcomes carry plain actionable failures and preserve cancellation", async () => {
  expect(await workspaceCopyOutcome(async () => { throw new Error("The source changed. Choose Save as again."); })).toEqual({ok: false, error: "The source changed. Choose Save as again."});
  expect(await workspaceCopyOutcome(async () => ({path: null}))).toEqual({ok: true, value: {path: null}});
});
test("copies binary bytes above the editor limit over authenticated owner-fenced HTTP", async () => {
  const f = await fixture(Buffer.alloc(3 * 1024 * 1024 + 73));
  f.bytes.forEach((_, index) => f.bytes[index] = index % 256); await writeFile(f.file, f.bytes);
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer disposable");
    expect(request.headers.get("X-Agent-Host-Id")).toBe("host");
    const body = await request.json() as {target: unknown; query: WorkspaceQuery}; expect(body.target).toEqual(f.input.target);
    return Response.json(await f.source.query(body.query), {headers: {"X-Agent-Host-Id": "host"}});
  }});
  try {
    const source = workspaceCopySource({origin: server.url.origin, hostId: "host", token: "disposable"}, f.input.target, false);
    expect(await saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => source})).toEqual({path: f.destination});
    expect(await readFile(f.destination)).toEqual(f.bytes);
    expect(f.calls.filter(call => call.type === "file.copy-chunk").map(call => call.offset)).toEqual([0, 1048576, 2097152, 3145728]);
    expect((await readdir(f.root)).sort()).toEqual(["copy.bin", "source.bin"]);
  } finally { server.stop(true); }
});
test("empty files and BOM/newlines are copied without re-encoding; existing mode retained", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from("\ufeffOne\r\nTwo\rThree\n")]) {
    const f = await fixture(bytes); await writeFile(f.destination, "old", {mode: 0o640});
    await saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source});
    expect(await readFile(f.destination)).toEqual(bytes); expect((await stat(f.destination)).mode & 0o777).toBe(0o640);
  }
});
test("local self-copy is a no-op but equal remote path must still copy", async () => {
  const f = await fixture(), before = await stat(f.file);
  f.source.local = true;
  await saveWorkspaceCopy(f.input, {choose: async () => f.file, source: async () => f.source});
  expect((await stat(f.file)).ino).toBe(before.ino); expect(f.calls.map(call => call.type)).toEqual(["file.copy-info"]);
  f.calls.length = 0; f.source.local = false;
  await saveWorkspaceCopy(f.input, {choose: async () => f.file, source: async () => f.source});
  expect(f.calls.some(call => call.type === "file.copy-chunk")).toBe(true); expect(await readFile(f.file)).toEqual(f.bytes);
});
test("destination symlink keeps its identity and updates its referent", async () => {
  const f = await fixture(), referent = join(f.root, "actual.bin");
  await writeFile(referent, "old"); await symlink(referent, f.destination); const before = await lstat(f.destination);
  await saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source});
  expect((await lstat(f.destination)).ino).toBe(before.ino); expect((await lstat(f.destination)).isSymbolicLink()).toBe(true);
  expect(await readFile(referent)).toEqual(f.bytes);
});
test("source change between chunks leaves old destination intact and removes temporary bytes", async () => {
  const f = await fixture(Buffer.alloc(2 * 1024 * 1024, 65)); await writeFile(f.destination, "keep");
  const query = f.source.query;
  f.source.query = async input => { const value = await query(input); if (input.type === "file.copy-chunk" && input.offset === 0) await writeFile(f.file, Buffer.alloc(f.bytes.length, 66)); return value; };
  await expect(saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source})).rejects.toThrow("changed");
  expect(await readFile(f.destination, "utf8")).toBe("keep"); expect((await readdir(f.root)).sort()).toEqual(["copy.bin", "source.bin"]);
});
test("destination change during download is preserved", async () => {
  const f = await fixture(); await writeFile(f.destination, "before"); const query = f.source.query;
  f.source.query = async input => { const value = await query(input); if (input.type === "file.copy-chunk") await writeFile(f.destination, "another app edited"); return value; };
  await expect(saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source})).rejects.toThrow("destination changed");
  expect(await readFile(f.destination, "utf8")).toBe("another app edited");
});
test("a destination created after choosing a new name is never overwritten", async () => {
  const f = await fixture(), query = f.source.query;
  f.source.query = async input => {
    const value = await query(input);
    if (input.type === "file.copy-chunk") await writeFile(f.destination, "arrived after the dialog");
    return value;
  };
  await expect(saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source})).rejects.toThrow("destination changed");
  expect(await readFile(f.destination, "utf8")).toBe("arrived after the dialog");
  expect((await readdir(f.root)).sort()).toEqual(["copy.bin", "source.bin"]);
});
test("retargeting a selected destination symlink during copy preserves both referents", async () => {
  const f = await fixture(Buffer.alloc(2 * 1024 * 1024, 65));
  const original = join(f.root, "original.bin"), replacement = join(f.root, "replacement.bin"), query = f.source.query;
  await writeFile(original, "original"); await writeFile(replacement, "replacement"); await symlink(original, f.destination);
  f.source.query = async input => {
    const value = await query(input);
    if (input.type === "file.copy-chunk" && input.offset === 0) { await rm(f.destination); await symlink(replacement, f.destination); }
    return value;
  };
  await expect(saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source})).rejects.toThrow("destination changed");
  expect((await lstat(f.destination)).isSymbolicLink()).toBe(true);
  expect(await readFile(original, "utf8")).toBe("original");
  expect(await readFile(replacement, "utf8")).toBe("replacement");
  expect((await readdir(f.root)).sort()).toEqual(["copy.bin", "original.bin", "replacement.bin", "source.bin"]);
});
test("a dangling destination link creates its missing referent and preserves the link", async () => {
  const f = await fixture(), missing = join(f.root, "missing.bin");
  await symlink(missing, f.destination);
  await saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source});
  expect((await lstat(f.destination)).isSymbolicLink()).toBe(true);
  expect(await readFile(missing)).toEqual(f.bytes);
  expect((await readdir(f.root)).sort()).toEqual(["copy.bin", "missing.bin", "source.bin"]);
});
test("a source revision change at final verification leaves the destination intact", async () => {
  const f = await fixture(), query = f.source.query; let infoCalls = 0;
  await writeFile(f.destination, "keep");
  f.source.query = async input => {
    if (input.type === "file.copy-info" && ++infoCalls === 2) await writeFile(f.file, "new source revision");
    return query(input);
  };
  await expect(saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source})).rejects.toThrow("source changed");
  expect(await readFile(f.destination, "utf8")).toBe("keep");
  expect((await readdir(f.root)).sort()).toEqual(["copy.bin", "source.bin"]);
});
test("invalid chunks, transport failures and closure abort do not replace destination", async () => {
  for (const kind of ["offset", "base64", "truncated", "transport", "abort"] as const) {
    const f = await fixture(); await writeFile(f.destination, "keep"); const query = f.source.query, abort = new AbortController();
    f.source.query = async input => {
      const value = await query(input);
      if (value.type === "file.copy-chunk") {
        if (kind === "transport") throw new Error("Disconnected");
        if (kind === "abort") abort.abort(new Error("Window closed"));
        if (kind === "offset") return {...value, offset: 12};
        if (kind === "base64") return {...value, dataBase64: value.dataBase64 + "!"};
        if (kind === "truncated") return {...value, dataBase64: ""};
      } return value;
    };
    await expect(saveWorkspaceCopy(f.input, {choose: async () => f.destination, source: async () => f.source, signal: abort.signal})).rejects.toThrow();
    expect(await readFile(f.destination, "utf8")).toBe("keep"); expect((await readdir(f.root)).sort()).toEqual(["copy.bin", "source.bin"]);
  }
});
test("transport rejects wrong owner and oversized response without writing", async () => {
  for (const oversized of [false, true]) {
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response(oversized ? "x".repeat(2 * 1024 * 1024) : "{}", {headers: {"X-Agent-Host-Id": oversized ? "owner" : "other"}})});
    try {
      await expect(workspaceCopySource({origin: server.url.origin, hostId: "owner"}, {projectId: "p"}, false).query({type: "file.copy-info", path: "a"})).rejects.toThrow(oversized ? "chunk limit" : "different host");
    } finally { server.stop(true); }
  }
});
test("authentication rejection is distinct from a different-host response", async () => {
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("Unauthorized", {status: 401})});
  try {
    await expect(workspaceCopySource({origin: server.url.origin, hostId: "owner"}, {projectId: "p"}, false).query({type: "file.copy-info", path: "a"})).rejects.toThrow("did not authorize");
  } finally { server.stop(true); }
});
test("invalid renderer owner/path inputs never show a dialog", async () => {
  let dialogs = 0;
  for (const path of ["../escape", "/absolute", "", "x\0y", "x\\y"]) {
    await expect(saveWorkspaceCopy({target: {projectId: "p"}, path, hostId: "h"}, {choose: async () => {dialogs++; return null;}, source: async () => {throw new Error("unused");}})).rejects.toThrow();
  }
  expect(dialogs).toBe(0);
});
