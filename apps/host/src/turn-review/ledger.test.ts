import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnLedger } from "./ledger";

for (const aliased of [false, true]) {
  test(`recorded snapshot excludes its native backing through ${aliased ? "an aliased" : "a canonical"} cwd`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "turn-ledger-backing-")));
    let manager: SessionManager | undefined;
    try {
      const project = join(root, "project"), alias = join(root, "alias");
      await mkdir(project);
      await symlink(project, alias);
      const cwd = aliased ? alias : project;
      manager = SessionManager.create(cwd, join(cwd, ".sessions"));
      await manager.ensureOnDisk();
      await manager.flush();
      const artifacts = manager.getArtifactsDir()!;
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, "private-tool-result"), "Private native tool output\n");
      await writeFile(join(cwd, ".sessions", "user-note.txt"), "A user file outside the original backing\n");
      await writeFile(join(cwd, "normal.txt"), "User content\n");
      const ledger = new TurnLedger(manager);
      const first = await ledger.snapshot(cwd);
      expect(first.issues).toEqual([]);
      expect(first.files.map(file => file.path)).toEqual([".sessions/user-note.txt", "normal.txt"]);
      await ledger.saveObject(first);
      const next = await ledger.snapshot(cwd);
      expect(next).toEqual(first);
      expect((await ledger.get(next.files[1]!.blob)).toString()).toBe("User content\n");
    } finally {
      await manager?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
