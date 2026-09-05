import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("packaged restart refuses an older permission-ignorant host before reading or touching any live app", async () => {
  const root = await mkdtemp(join(tmpdir(), "packaged-schema-preflight-"));
  try {
    const bundle = join(root, "Old.app"), data = join(root, "data");
    await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
    await mkdir(join(bundle, "Contents/Resources/host"), { recursive: true }); await mkdir(data);
    // No connection locator, OS helper or running app exists in this fixture.
    // The CLI must reject the committed schema before trying to locate one.
    await writeFile(join(bundle, "Contents/MacOS/Agent Desktop"), "not executable");
    await writeFile(join(bundle, "Contents/Resources/host/host-artifact.json"), JSON.stringify({ format: 1, version: "old-schema-1" }));
    const file = join(data, "state.sqlite"), db = new Database(file);
    db.exec("PRAGMA user_version=2; CREATE TABLE intact(value TEXT); INSERT INTO intact VALUES ('permission intent retained');"); db.close();
    const before = await readFile(file);
    const child = Bun.spawn([process.execPath, resolve("scripts/restart-packaged.ts"), bundle, data], { stdout: "pipe", stderr: "pipe" });
    const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(1); expect(output).toContain("Host state schema 2 is incompatible");
    expect(output).not.toContain("connection.json"); expect(output).not.toContain("Yabai could not verify");
    expect(await readFile(file)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
