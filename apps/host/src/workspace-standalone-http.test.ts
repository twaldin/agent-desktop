import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseStandaloneFilePath, WORKSPACE_OWNER_HEADER, type CommandEnvelope, type CommandResult, type WorkspaceMutation, type WorkspaceQueryResult } from "@agent-desktop/shared";
import { startHost } from "./server";
import { parseWorkspaceTarget } from "./workspace-http";

type Host = Awaited<ReturnType<typeof startHost>>;
const roots: string[] = [], hosts = new Set<Host>();
afterEach(async () => {
  await Promise.allSettled([...hosts].map(host => host.stop())); hosts.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-standalone-file-"))); roots.push(root);
  const files = join(root, "files"), agent = join(root, "agent"), discovery = join(root, "discovery");
  await Promise.all([mkdir(files), mkdir(agent), mkdir(discovery)]);
  const filePath = join(files, "outside project.md"), otherPath = join(files, "other.md");
  await writeFile(filePath, "first revision\n"); await writeFile(otherPath, "other\n");
  const launches: Array<{ executable: string; args: string[]; cwd: string }> = [];
  const host = await startHost({ dataDirectory: join(root, "data"), agentDirectory: agent, discoveryDirectory: discovery,
    workerPath: join(import.meta.dir, "omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0,
    workspaceFileOpen: { platform: "darwin", environment: {}, homeDirectory: root,
      available: async path => path === "/usr/bin/open", launch: async (executable, args, cwd) => { launches.push({ executable, args, cwd }); } } });
  hosts.add(host);
  const headers = { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" };
  const target = { filePath }, name = basename(filePath);
  const query = (query: unknown, inputTarget: unknown = target, owner = false) => fetch(`${host.connection.origin}/v1/workspace/query`, {
    method: "POST", headers: { ...headers, ...(owner ? { [WORKSPACE_OWNER_HEADER]: host.store.host.id } : {}) },
    body: JSON.stringify({ target: inputTarget, query }),
  });
  const command = async (envelope: CommandEnvelope): Promise<CommandResult> => {
    const response = await fetch(`${host.connection.origin}/v1/commands`, { method: "POST", headers, body: JSON.stringify(envelope) });
    expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
  };
  return { root, files, discovery, filePath, otherPath, target, name, host, headers, launches, query, command };
}

test("standalone targets validate one canonical absolute POSIX file path", () => {
  expect(parseStandaloneFilePath("/tmp/folder/file name.md")).toBe("/tmp/folder/file name.md");
  expect(parseWorkspaceTarget({ filePath: "/tmp/folder/file name.md" })).toEqual({ filePath: "/tmp/folder/file name.md" });
  for (const filePath of ["relative.md", "/", "/tmp//file", "/tmp/./file", "/tmp/../file", "/tmp/file/", "/tmp\\file", "/tmp/new\nline", "/tmp/\u0085", "/tmp/\ud800"])
    expect(() => parseStandaloneFilePath(filePath)).toThrow("canonical absolute");
  for (const target of [{ filePath: "/tmp/file", projectId: "project" }, { filePath: 12 }, { cwd: "/tmp" }])
    expect(() => parseWorkspaceTarget(target)).toThrow();
});

test("standalone HTTP reads, copies, writes, and opens only its exact basename", async () => {
  const f = await fixture();
  const unauthorized = await fetch(`${f.host.connection.origin}/v1/workspace/query`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: f.target, query: { type: "file.read", path: f.name } }) });
  expect(unauthorized.status).toBe(401);

  const readResponse = await f.query({ type: "file.read", path: f.name });
  expect(readResponse.status).toBe(200);
  const read = await readResponse.json() as Extract<WorkspaceQueryResult, { type: "file.read" }>;
  expect(read).toMatchObject({ type: "file.read", content: { kind: "text", text: "first revision\n" } });
  if (read.content.kind !== "text") throw new Error("Expected a standalone text document");
  expect(await (await f.query({ type: "file.stat", path: f.name })).json()).toMatchObject({ type: "file.stat", entry: { path: f.name, kind: "file" } });
  expect((await f.query({ type: "file.copy-info", path: f.name })).status).toBe(409);
  const infoResponse = await f.query({ type: "file.copy-info", path: f.name }, f.target, true);
  expect(infoResponse.status).toBe(200); expect(infoResponse.headers.get(WORKSPACE_OWNER_HEADER)).toBe(f.host.store.host.id);
  const info = await infoResponse.json() as Extract<WorkspaceQueryResult, { type: "file.copy-info" }>;
  expect(info).toMatchObject({ type: "file.copy-info", path: f.name, absolutePath: f.filePath });
  const chunk = await (await f.query({ type: "file.copy-chunk", path: f.name, revision: info.revision, offset: 0 }, f.target, true)).json() as Extract<WorkspaceQueryResult, { type: "file.copy-chunk" }>;
  expect(Buffer.from(chunk.dataBase64, "base64").toString("utf8")).toBe("first revision\n");

  const write = await f.command({ id: "standalone-write", command: { type: "workspace.mutate", target: f.target,
    action: { type: "file.write", path: f.name, text: "second revision\n", expectedRevision: read.content.revision } } });
  expect(write).toMatchObject({ ok: true, value: { type: "file.write", result: { ok: true, document: { text: "second revision\n" } } } });
  const stale = await f.command({ id: "standalone-stale", command: { type: "workspace.mutate", target: f.target,
    action: { type: "file.write", path: f.name, text: "lost edit\n", expectedRevision: read.content.revision } } });
  expect(stale).toMatchObject({ ok: true, value: { type: "file.write", result: { ok: false, code: "REVISION_CONFLICT", current: { text: "second revision\n" } } } });
  expect(await f.command({ id: "standalone-open", command: { type: "workspace.mutate", target: f.target,
    action: { type: "file.open", path: f.name, targetId: "systemDefault" } } })).toMatchObject({ ok: true, value: { type: "file.open", targetId: "systemDefault" } });
  expect(f.launches).toEqual([{ executable: "/usr/bin/open", args: [f.filePath], cwd: f.files }]);
  expect(await readFile(f.filePath, "utf8")).toBe("second revision\n");
  expect(await readFile(f.otherPath, "utf8")).toBe("other\n");
  expect(f.host.store.getCommand("standalone-write")?.command).toBeUndefined();
  expect(f.host.store.eventsAfter(0).filter(event => event.type === "workspace").map(event => ({ type: event.type, target: event.target })))
    .toEqual(Array.from({ length: 3 }, () => ({ type: "workspace", target: f.target })));
  const durable = new Database(join(f.root, "data", "state.sqlite"), { readonly: true, strict: true });
  try {
    expect(durable.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
    const payloads = [
      ...durable.query<{ data: string }, []>("SELECT data FROM commands").all(),
      ...durable.query<{ data: string }, []>("SELECT data FROM events").all(),
    ];
    expect(payloads.filter(row => row.data.includes('"filePath"'))).toHaveLength(3);
    expect(durable.query<{ data: string }, []>("SELECT data FROM commands").all().some(row => row.data.includes('"filePath"'))).toBe(false);
  } finally { durable.close(); }
});

test("standalone targets reject missing, traversal, other-file, directory, Git, and environment authority", async () => {
  const f = await fixture();
  for (const path of [basename(f.otherPath), "../other.md", f.otherPath, ".", ""]) {
    const response = await f.query({ type: "file.read", path }); expect(response.status).toBe(400);
  }
  expect((await f.query({ type: "file.read", path: "missing.md" }, { filePath: join(f.files, "missing.md") })).status).toBe(400);
  for (const query of [{ type: "files.list" }, { type: "git.status" }, { type: "environments.list" }, { type: "environment.actions" }])
    expect((await f.query(query)).status).toBe(400);
  for (const action of [
    { type: "file.write", path: basename(f.otherPath), text: "blocked\n", expectedRevision: null },
    { type: "file.open", path: basename(f.otherPath), targetId: "systemDefault" },
    { type: "environment.save", expectedRevision: null, raw: "version: 1\n" },
    { type: "git.stage", paths: [f.name] },
    { type: "worktree.create", options: { path: "blocked" } },
  ] satisfies WorkspaceMutation[]) {
    const result = await f.command({ id: crypto.randomUUID(), command: { type: "workspace.mutate", target: f.target, action } });
    expect(result).toMatchObject({ ok: false, error: { code: "COMMAND_FAILED" } });
  }
  expect(f.host.store.listProjects()).toEqual([]); expect(f.host.store.listSessions()).toEqual([]);
  expect(await stat(join(f.discovery, ".git")).then(() => true, () => false)).toBe(false);
  expect(await readFile(f.otherPath, "utf8")).toBe("other\n"); expect(f.launches).toEqual([]);
});
