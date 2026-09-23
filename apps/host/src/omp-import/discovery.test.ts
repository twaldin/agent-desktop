import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeSessionImportDiscovery } from "./discovery";

test("native import discovery reads existing profile directories and original journals without migrating or admitting writers", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-import-discovery-")));
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/discovery-scenario.ts", import.meta.url)), root], {
      cwd: root, env: { HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), TMPDIR: root, PATH: process.env.PATH, SHELL: "/bin/sh", TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Native import discovery fixture failed: ${stderr}`);
    expect(JSON.parse(stdout)).toEqual({ missingRootNotCreated: true, originalHistoriesAndBackupPreserved: true, nativeInspection: true,
      ownershipStillRequired: true, exactReviewedSourceAndStaleRefusal: true, stableOpaqueIds: true, aliasesAndBounds: true, cancellationAndConcurrentRead: true, removedSourceRetired: true });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("discovery requires an owning-host absolute profile and bounded positive limits", () => {
  expect(() => new NativeSessionImportDiscovery({ sessionsRoot: "relative" })).toThrow("absolute");
  for (const value of [0, -1, 1.5, 10001, NaN]) {
    expect(() => new NativeSessionImportDiscovery({ sessionsRoot: "/profile", maxDirectories: value })).toThrow("limits");
    expect(() => new NativeSessionImportDiscovery({ sessionsRoot: "/profile", maxCandidates: value })).toThrow("limits");
  }
});
