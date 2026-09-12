import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "../omp-workers";
import { IntegrationsHttp } from "../integrations-http";
import type { NativeSshCatalog } from "@agent-desktop/shared";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-ssh-http-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await mkdir(agentDir); await mkdir(path.join(cwd, ".git"), { recursive: true });
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\n");
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", PATH: "/usr/bin:/bin", TMPDIR: root, TERM: "dumb" } });
  cleanups.push(() => runtime.dispose());
  const changes: unknown[] = [];
  const service = new IntegrationsHttp({ runtime, resolveCwd: target => {
    if (!target || "projectId" in target && target.projectId === "owned") return cwd;
    throw new Error("private owner path must not cross HTTP");
  }, changed: target => changes.push(target) });
  cleanups.push(() => service.dispose());
  const post = (operation: string, body: unknown) => {
    const url = new URL(`http://localhost/v1/integrations/ssh/${operation}`);
    return service.route(new Request(url, { method: "POST", body: JSON.stringify(body) }), url).then(response => response!);
  };
  return { root, agentDir, cwd, runtime, service, changes, post };
}

test("SSH configuration HTTP resolves the owner, edits through the real worker and rejects stale or unowned writes", async () => {
  const f = await fixture();
  const initial = await f.post("read", { target: { projectId: "owned" } });
  expect(initial.status).toBe(200); expect(initial.headers.get("cache-control")).toBe("no-store");
  let catalog = await initial.json() as NativeSshCatalog;
  expect(catalog.hosts).toEqual([]);
  const mutation = { operation: "add", expectedRevision: catalog.revision, scope: "project", name: "fixture", config: { host: "fixture.invalid", port: 2222, keyPath: "~/.ssh/not-read", compat: true } };
  expect((await f.post("mutate", { mutation })).status).toBe(400);
  expect((await f.post("mutate", { target: { cwd: f.cwd }, mutation })).status).toBe(400);
  expect((await f.post("mutate", { target: { projectId: "missing" }, mutation })).status).toBe(400);
  expect(f.changes).toEqual([]);
  const saved = await f.post("mutate", { target: { projectId: "owned" }, mutation });
  expect(saved.status).toBe(200); catalog = await saved.json() as NativeSshCatalog;
  expect(catalog.hosts).toHaveLength(1); expect(f.changes).toEqual([{ projectId: "owned" }]);
  const selected = catalog.hosts[0]!;
  const detail = await f.post("detail", { target: { projectId: "owned" }, request: { hostId: selected.id, expectedRevision: catalog.revision } });
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ config: mutation.config, host: { name: "fixture", scope: "project" } });
  expect((await f.post("mutate", { target: { projectId: "owned" }, mutation })).status).toBe(400);
  const file = path.join(f.cwd, ".omp", "ssh.json"), before = await readFile(file, "utf8");
  const unsafe = JSON.parse('{"host":"valid.invalid","__proto__":{"polluted":true}}');
  expect((await f.post("mutate", { target: { projectId: "owned" }, mutation: { operation: "update", hostId: selected.id, expectedRevision: catalog.revision, config: unsafe } })).status).toBe(400);
  expect(await readFile(file, "utf8")).toBe(before); expect(f.changes).toHaveLength(1);
  const removed = await f.post("mutate", { target: { projectId: "owned" }, mutation: { operation: "remove", hostId: selected.id, expectedRevision: catalog.revision } });
  expect(removed.status).toBe(200); expect((await removed.json() as NativeSshCatalog).hosts).toEqual([]);
  expect(f.changes).toHaveLength(2);
  await f.service.dispose(); expect((await f.post("read", {})).status).toBe(503);
}, 30_000);

test("SSH HTTP does not expose native config diagnostics and leaves malformed target bytes intact", async () => {
  const f = await fixture(), file = path.join(f.agentDir, "ssh.json"), bytes = '{private-fixture-secret';
  await writeFile(file, bytes);
  const read = await f.post("read", {}), catalog = await read.json() as NativeSshCatalog;
  expect(read.status).toBe(200); expect(JSON.stringify(catalog)).not.toContain("private-fixture-secret");
  const saved = await f.post("mutate", { mutation: { operation: "add", scope: "user", name: "fixture", config: { host: "fixture.invalid" }, expectedRevision: catalog.revision } });
  expect(saved.status).toBe(400); expect(await saved.text()).not.toContain("private-fixture-secret");
  expect(await readFile(file, "utf8")).toBe(bytes); expect(f.changes).toEqual([]);
}, 30_000);
