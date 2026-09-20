import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
test.skipIf(process.platform === "win32")("read-only file navigation and copy preserve literal POSIX Git filenames and containment", async () => {
  const root = await mkdtemp(join(tmpdir(), "branch-read-path-")); roots.push(root);
  const outside = await mkdtemp(join(tmpdir(), "branch-read-outside-")); roots.push(outside);
  const name = "literal\\backslash\tline\n.txt", bytes = "actual fixture content\n";
  await writeFile(join(root, name), bytes); await writeFile(join(outside, "secret"), "outside");
  await mkdir(join(root, "directory\\literal")); await writeFile(join(root, "directory\\literal", name), bytes);
  await symlink("directory\\literal", join(root, "alias"));
  const workspace = new WorkspaceService(root);
  expect(await workspace.readText(`alias/${name}`)).toMatchObject({ kind: "text", text: bytes });
  expect(await workspace.readText(`directory\\literal/${name}`)).toMatchObject({ kind: "text", text: bytes });
  expect(await workspace.readText(name)).toMatchObject({ kind: "text", text: bytes, path: name });
  expect((await workspace.readBytes(name)).bytes.toString()).toBe(bytes);
  expect(await workspace.externalFilePath(name)).toBe(join(workspace.cwd, name));
  const info = await workspace.copyInfo(name);
  expect(Buffer.from((await workspace.copyChunk(name, info.revision, 0)).dataBase64, "base64").toString()).toBe(bytes);
  await symlink(join(outside, "secret"), join(root, "escape\\link"));
  await symlink(outside, join(root, "escape\\directory"));
  for (const path of [join(outside, "secret"), "../secret", "escape\\link", "escape\\directory/secret", "a/../secret", "nul\0.txt"]) {
    await expect(workspace.readText(path)).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
    await expect(workspace.copyInfo(path)).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
  }
  // Opening a POSIX name does not expand the existing write/mutation path policy.
  await expect(workspace.writeText(name, { text: "changed", expectedRevision: null })).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
  expect(await readFile(join(root, name), "utf8")).toBe(bytes);
});
