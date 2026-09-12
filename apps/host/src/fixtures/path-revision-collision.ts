import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

// Run in a child process: only this fixture sees coarse change timestamps.
// File bytes, inode identities, reads and mutations still use the real filesystem.
const original = { ...fs };
const coarse = <T extends object>(value: T): T => {
  if (!("ctimeNs" in value)) return value;
  return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ctimeNs: 1n });
};
mock.module("node:fs/promises", () => ({
  ...original,
  lstat: async (...args: Parameters<typeof fs.lstat>) => coarse(await original.lstat(...args)),
  stat: async (...args: Parameters<typeof fs.stat>) => coarse(await original.stat(...args)),
  open: async (...args: Parameters<typeof fs.open>) => {
    const file = await original.open(...args), stat = file.stat.bind(file);
    file.stat = (async (...options: Parameters<typeof file.stat>) => coarse(await stat(...options))) as typeof file.stat;
    return file;
  },
}));

const { WorkspaceService } = await import("../workspace/service");
const root = await original.mkdtemp(join(tmpdir(), "path-revision-collision-"));
const epoch = new Date(1_700_000_000_000);
try {
  const service = new WorkspaceService(root);
  for (const operation of ["rename", "delete"] as const) {
    const path = `${operation}.bin`, target = join(root, path);
    // Cross the reader's chunk boundary, and change only the last byte.
    const before = Buffer.alloc(1024 * 1024 + 17, 65);
    await original.writeFile(target, before);
    await original.utimes(target, epoch, epoch);
    const reviewed = await service.pathContext(path);
    const after = Buffer.from(before); after[after.length - 1] = 66;
    await original.writeFile(target, after);
    await original.utimes(target, epoch, epoch);
    await assert.rejects(
      operation === "rename" ? service.renamePath(path, `${path}.moved`, reviewed.revision) : service.deletePath(path, reviewed.revision),
      { code: "REVISION_CONFLICT" },
    );
    assert.deepEqual(await original.readFile(target), after);
    const current = await service.pathContext(path);
    if (operation === "rename") {
      await service.renamePath(path, `${path}.moved`, current.revision);
      assert.deepEqual(await original.readFile(`${target}.moved`), after);
    } else {
      await service.deletePath(path, current.revision);
      await assert.rejects(original.lstat(target), { code: "ENOENT" });
    }
  }
  console.log(JSON.stringify({ ok: true, operations: ["rename", "delete"], bytes: 1024 * 1024 + 17 }));
} finally {
  await original.rm(root, { recursive: true, force: true });
}
