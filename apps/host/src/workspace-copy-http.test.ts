import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_OWNER_HEADER } from "@agent-desktop/shared";
import { startHost } from "./server";
import { parseWorkspaceQuery } from "./workspace-http";

type Host = Awaited<ReturnType<typeof startHost>>;
const roots: string[] = [], hosts = new Set<Host>();
afterEach(async () => {
  await Promise.allSettled([...hosts].map(host => host.stop())); hosts.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-workspace-copy-"))); roots.push(root);
  const project = join(root, "project"), agent = join(root, "agent"); await mkdir(project); await mkdir(agent);
  const bytes = Buffer.alloc(1024 * 1024 + 257); for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await writeFile(join(project, "binary.dat"), bytes); await writeFile(join(project, "empty.dat"), Buffer.alloc(0));
  await writeFile(join(root, "outside.dat"), "outside"); await symlink(join(root, "outside.dat"), join(project, "outside-link.dat"));
  await symlink(join(project, "binary.dat"), join(project, "inside-link.dat"));
  const host = await startHost({ dataDirectory: join(root, "data"), agentDirectory: agent, discoveryDirectory: project,
    workerPath: join(import.meta.dir, "omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0 });
  hosts.add(host); const owner = host.store.addProject({ path: project });
  const query = (value: unknown, ownerHeader = host.store.host.id) => fetch(`${host.connection.origin}/v1/workspace/query`, {
    method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", [WORKSPACE_OWNER_HEADER]: ownerHeader },
    body: JSON.stringify({ target: { projectId: owner.id }, query: value }),
  });
  return { root, project, bytes, host, query };
}

test("authenticated copy queries stream byte-exact bounded chunks from one file revision", async () => {
  const f = await fixture();
  const denied = await f.query({ type: "file.copy-info", path: "binary.dat" }, "wrong-host");
  expect(denied.status).toBe(409); expect(denied.headers.get(WORKSPACE_OWNER_HEADER)).toBe(f.host.store.host.id);
  expect(denied.headers.get("cache-control")).toBe("no-store");
  const malformed = await f.query({ type: "file.copy-chunk", path: "binary.dat", revision: "bad", offset: 0 });
  expect(malformed.status).toBe(400); expect(malformed.headers.get(WORKSPACE_OWNER_HEADER)).toBe(f.host.store.host.id);

  const infoResponse = await f.query({ type: "file.copy-info", path: "binary.dat" });
  expect(infoResponse.status).toBe(200); expect(infoResponse.headers.get(WORKSPACE_OWNER_HEADER)).toBe(f.host.store.host.id);
  const info = await infoResponse.json() as { type: string; path: string; absolutePath: string; size: number; revision: string };
  expect(info).toMatchObject({ type: "file.copy-info", path: "binary.dat", absolutePath: join(f.project, "binary.dat"), size: f.bytes.length });
  expect(info.revision).toMatch(/^[a-f0-9]{64}$/);

  const chunks: Buffer[] = [];
  for (let offset = 0; offset < info.size;) {
    const response = await f.query({ type: "file.copy-chunk", path: info.path, revision: info.revision, offset });
    expect(response.status).toBe(200); expect(response.headers.get(WORKSPACE_OWNER_HEADER)).toBe(f.host.store.host.id);
    const chunk = await response.json() as { type: string; path: string; size: number; revision: string; offset: number; dataBase64: string };
    expect(chunk).toMatchObject({ type: "file.copy-chunk", path: info.path, size: info.size, revision: info.revision, offset });
    const decoded = Buffer.from(chunk.dataBase64, "base64"); expect(decoded.length).toBeLessThanOrEqual(1024 * 1024);
    expect(chunk.dataBase64.length).toBeLessThan(1.5 * 1024 * 1024);
    expect(decoded.length).toBeGreaterThan(0); chunks.push(decoded); offset += decoded.length;
  }
  expect(Buffer.concat(chunks)).toEqual(f.bytes);
  const eof = await (await f.query({ type: "file.copy-chunk", path: info.path, revision: info.revision, offset: info.size })).json() as { dataBase64: string };
  expect(eof.dataBase64).toBe("");
});

test("copy supports empty and confined symlink files, while changed and escaped sources fail closed", async () => {
  const f = await fixture();
  const empty = await (await f.query({ type: "file.copy-info", path: "empty.dat" })).json() as { size: number; revision: string };
  expect(empty.size).toBe(0);
  const emptyChunk = await (await f.query({ type: "file.copy-chunk", path: "empty.dat", revision: empty.revision, offset: 0 })).json() as { dataBase64: string };
  expect(emptyChunk.dataBase64).toBe("");

  const linked = await (await f.query({ type: "file.copy-info", path: "inside-link.dat" })).json() as { path: string; absolutePath: string; revision: string };
  expect(linked).toMatchObject({ path: "inside-link.dat", absolutePath: join(f.project, "binary.dat") });
  await writeFile(join(f.project, "binary.dat"), Buffer.from("changed"));
  const stale = await f.query({ type: "file.copy-chunk", path: "inside-link.dat", revision: linked.revision, offset: 0 });
  expect(stale.status).toBe(400); expect(stale.headers.get(WORKSPACE_OWNER_HEADER)).toBe(f.host.store.host.id);

  for (const path of ["../outside.dat", "outside-link.dat", "missing.dat", "."]) {
    const response = await f.query({ type: "file.copy-info", path }); expect(response.status).toBe(400);
    expect(response.headers.get(WORKSPACE_OWNER_HEADER)).toBe(f.host.store.host.id);
  }
});

test("copy query parser requires bounded paths, exact revisions, and safe non-negative offsets", () => {
  const revision = "a".repeat(64);
  expect(parseWorkspaceQuery({ type: "file.copy-info", path: "file.dat" })).toEqual({ type: "file.copy-info", path: "file.dat" });
  expect(parseWorkspaceQuery({ type: "file.copy-chunk", path: "file.dat", revision, offset: Number.MAX_SAFE_INTEGER }))
    .toEqual({ type: "file.copy-chunk", path: "file.dat", revision, offset: Number.MAX_SAFE_INTEGER });
  for (const query of [
    { type: "file.copy-chunk", path: "file.dat", revision: "short", offset: 0 },
    { type: "file.copy-chunk", path: "file.dat", revision, offset: -1 },
    { type: "file.copy-chunk", path: "file.dat", revision, offset: 0.5 },
    { type: "file.copy-chunk", path: "file.dat", revision, offset: Number.MAX_SAFE_INTEGER + 1 },
  ]) expect(() => parseWorkspaceQuery(query)).toThrow("Invalid file copy revision or offset");
});
