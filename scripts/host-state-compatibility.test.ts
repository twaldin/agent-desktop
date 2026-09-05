import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkHostStateCompatibility, supportedHostStateSchemaVersions } from "./host-state-compatibility";
import { installHost, manageHost, serviceLayout, type HostServiceLifecycle, type ServiceLayout } from "./install-host";

const directories: string[] = [];
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), "agent-state-compatibility-")); directories.push(path); return path; }
async function database(directory: string, version: number) {
  await mkdir(directory, { recursive: true });
  const db = new Database(join(directory, "state.sqlite"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version = ${version}`);
  return db;
}
function lifecycle(onStop?: () => void, onHealthy?: () => void) {
  const calls: string[] = [];
  const hooks: HostServiceLifecycle = {
    async stop() { calls.push("stop"); onStop?.(); },
    async start() { calls.push("start"); },
    async healthy() { calls.push("healthy"); onHealthy?.(); return { hostId: "isolated-service-fixture" }; },
  };
  return { calls, hooks };
}
async function artifact(directory: string, version: string, stateSchemaVersions?: number[]) {
  // These inert files are archive/manifest fixtures, never an emulated native runtime.
  const files: Record<string, string> = {};
  for (const [file, value] of Object.entries({ "package.json": '{"private":true}', "bun.lock": "fixture lock\n", "apps/host/src/server.ts": "export {};\n", "scripts/install-host.ts": "export {};\n" })) {
    await mkdir(dirname(join(directory, file)), { recursive: true }); await writeFile(join(directory, file), value); files[file] = hash(value);
  }
  await writeFile(join(directory, "host-artifact.json"), JSON.stringify({ format: 1, version, bunVersion: "1.3.14", ompVersion: "18.1.10", ...(stateSchemaVersions ? { stateSchemaVersions } : {}), files }));
}
async function installedFixture(schema: number) {
  const root = await temporary();
  const layout = serviceLayout({ platform: "linux", homeDirectory: root });
  const current = join(layout.installDirectory, "versions/current12"), target = join(layout.installDirectory, "versions/legacy11");
  await artifact(current, "current12", [1, 2]); await artifact(target, "legacy11");
  await symlink("versions/current12", join(layout.installDirectory, "current"));
  await writeFile(join(layout.installDirectory, "installation.json"), JSON.stringify({ version: "current12", previousVersion: "legacy11", fixture: "unchanged" }));
  await mkdir(dirname(layout.serviceFile), { recursive: true }); await writeFile(layout.serviceFile, "isolated service fixture\n");
  (await database(layout.dataDirectory, schema)).close();
  return { root, layout, current, target };
}
async function preservation(layout: ServiceLayout) {
  return {
    current: await readlink(join(layout.installDirectory, "current")),
    record: await readFile(join(layout.installDirectory, "installation.json"), "utf8"),
    service: await readFile(layout.serviceFile, "utf8"),
    database: hash(await readFile(join(layout.dataDirectory, "state.sqlite"))),
    dataFiles: (await readdir(layout.dataDirectory)).sort(),
  };
}

describe("host artifact state compatibility", () => {
  test("new data is accepted without creating directories or a database", async () => {
    const path = join(await temporary(), "not-created");
    expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2] }, path)).toEqual({ checkedSchemaVersion: null, supportedStateSchemaVersions: [1, 2], legacyManifest: false });
    expect(checkHostStateCompatibility({}, path).legacyManifest).toBe(true);
    expect(await stat(path).then(() => true, () => false)).toBe(false);
  });

  test("legacy manifests remain valid for actual schema1 and reads do not change bytes or mode", async () => {
    const path = await temporary(); (await database(path, 1)).close();
    const file = join(path, "state.sqlite"); await chmod(file, 0o400);
    const before = await stat(file), contents = await readFile(file);
    expect(checkHostStateCompatibility({}, path)).toEqual({ checkedSchemaVersion: 1, supportedStateSchemaVersions: [1], legacyManifest: true });
    expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2] }, path).checkedSchemaVersion).toBe(1);
    expect(await readFile(file)).toEqual(contents); const after = await stat(file);
    expect(after.mode).toBe(before.mode); expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("committed WAL schema2 is visible without checkpointing, downgrading or reading durable payloads", async () => {
    const path = await temporary(), db = await database(path, 1);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA user_version = 2;");
      const before = await readFile(join(path, "state.sqlite")), wal = await readFile(join(path, "state.sqlite-wal"));
      expect(() => checkHostStateCompatibility({}, path)).toThrow("schema 2 is incompatible");
      expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2] }, path).checkedSchemaVersion).toBe(2);
      expect(await readFile(join(path, "state.sqlite"))).toEqual(before); expect(await readFile(join(path, "state.sqlite-wal"))).toEqual(wal);
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(2);
    } finally { db.close(); }
  });

  test("unknown versions, malformed declarations and unreadable databases fail closed", async () => {
    for (const declared of [null, [], [1, 1], [0], [-1], [1.2], ["1"], [2 ** 32], "1,2"]) expect(() => supportedHostStateSchemaVersions({ stateSchemaVersions: declared })).toThrow();
    const path = await temporary(); (await database(path, 42)).close();
    expect(() => checkHostStateCompatibility({ stateSchemaVersions: [1, 2] }, path)).toThrow("schema 42 is incompatible");
    await writeFile(join(path, "state.sqlite"), "not a SQLite database");
    expect(() => checkHostStateCompatibility({ stateSchemaVersions: [1, 2] }, path)).toThrow();
  });

  test("attachment schema3 rejects release13 readers without changing durable state", async () => {
    const path = await temporary(), db = await database(path, 1);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA user_version = 3;");
      const bytes = await readFile(join(path, "state.sqlite")), wal = await readFile(join(path, "state.sqlite-wal"));
      expect(() => checkHostStateCompatibility({ stateSchemaVersions: [1, 2] }, path)).toThrow("schema 3 is incompatible");
      expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2, 3] }, path).checkedSchemaVersion).toBe(3);
      expect(await readFile(join(path, "state.sqlite"))).toEqual(bytes);
      expect(await readFile(join(path, "state.sqlite-wal"))).toEqual(wal);
    } finally { db.close(); }
  });

  test("installing an incompatible real archive never stops service or replaces current", async () => {
    const { root, layout } = await installedFixture(2), candidate = join(root, "candidate");
    await artifact(candidate, "incoming11");
    const archive = join(root, "candidate.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", candidate, "."], { stdout: "pipe", stderr: "pipe" }).success).toBe(true);
    const before = await preservation(layout), service = lifecycle();
    await expect(installHost({ archive, bun: process.execPath, layout, lifecycle: service.hooks })).rejects.toThrow("Refusing to stop or replace the current host");
    expect(service.calls).toEqual([]); expect(await preservation(layout)).toEqual(before);
    expect((await readdir(join(layout.installDirectory, "versions"))).sort()).toEqual(["current12", "legacy11"]);
    expect((await readdir(layout.installDirectory)).some(name => name.startsWith(".staging-"))).toBe(false);
  });

  test("incompatible rollback keeps the current service, symlink, record, files and database intact", async () => {
    const { layout } = await installedFixture(2), before = await preservation(layout), service = lifecycle();
    await expect(manageHost("rollback", layout, undefined, service.hooks)).rejects.toThrow("schema 2 is incompatible");
    expect(service.calls).toEqual([]); expect(await preservation(layout)).toEqual(before);
  });

  test("legacy rollback on actual schema1 retains normal lifecycle and creates a private unchanged-state backup", async () => {
    const { layout } = await installedFixture(1), before = await preservation(layout), service = lifecycle();
    const result = await manageHost("rollback", layout, undefined, service.hooks) as { rolledBack: boolean; backup: string };
    expect(result.rolledBack).toBe(true); expect(service.calls).toEqual(["stop", "start", "healthy"]);
    expect(await readlink(join(layout.installDirectory, "current"))).toBe("versions/legacy11");
    expect(hash(await readFile(join(layout.dataDirectory, "state.sqlite")))).toBe(before.database);
    expect(hash(await readFile(join(result.backup, "state.sqlite")))).toBe(before.database);
    expect((await stat(join(result.backup, "state.sqlite"))).mode & 0o777).toBe(0o600);
  });

  test("promotion during stop rejects activation and restarts the unchanged compatible current service", async () => {
    const { layout } = await installedFixture(1), before = await preservation(layout);
    const service = lifecycle(() => { const db = new Database(join(layout.dataDirectory, "state.sqlite")); try { db.exec("PRAGMA user_version = 2"); } finally { db.close(); } });
    await expect(manageHost("rollback", layout, undefined, service.hooks)).rejects.toThrow("Current release was not replaced; its service was restarted");
    expect(service.calls).toEqual(["stop", "start", "healthy"]);
    const after = await preservation(layout);
    expect(after.current).toBe(before.current); expect(after.record).toBe(before.record); expect(after.service).toBe(before.service); expect(after.dataFiles).toEqual(before.dataFiles);
    expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2] }, layout.dataDirectory).checkedSchemaVersion).toBe(2);
  });

  test("failed target startup cannot automatically recover to an older reader after promotion", async () => {
    const { layout, current, target } = await installedFixture(1);
    await artifact(current, "current12", [1]); await artifact(target, "legacy11", [1, 2]);
    const service = lifecycle(undefined, () => { const db = new Database(join(layout.dataDirectory, "state.sqlite")); try { db.exec("PRAGMA user_version = 2"); } finally { db.close(); } throw new Error("isolated target health failure"); });
    await expect(manageHost("rollback", layout, undefined, service.hooks)).rejects.toThrow("Target host failed: isolated target health failure. Automatic recovery to current12 was not completed: Host state schema 2 is incompatible");
    expect(service.calls).toEqual(["stop", "start", "healthy"]);
    expect(await readlink(join(layout.installDirectory, "current"))).toBe("versions/legacy11");
    expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2] }, layout.dataDirectory).checkedSchemaVersion).toBe(2);
  });
});
