import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("image follow-up stop joins a held actual native call before releasing its enqueue guard", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-image-follow-up-stop-")));
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/native-image-follow-up-cancel.ts", import.meta.url)), root], {
      cwd: root, env: { HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PATH: process.env.PATH,
        TMPDIR: tmpdir(), TERM: "dumb", ...(process.env.IMAGE_STEER_MODULE ? { IMAGE_STEER_MODULE: process.env.IMAGE_STEER_MODULE } : {}) }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Isolated native image cancellation failed: ${stderr}\n${stdout}`);
    expect(stdout).toContain("actual image follow-up cancellation retained native dispatch and prevented replay");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("actual native steer object identity, parallel queue, stop and persistence uncertainty (controlled transport)", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-native-steer-")));
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/native-steer-identity.ts", import.meta.url)), root], {
      cwd: root, env: { HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), STEER_CONTRACT_GATES: path.join(root, "gates"),
        PATH: process.env.PATH, SHELL: "/bin/sh", TMPDIR: tmpdir(), TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Isolated native steer identity failed: ${stderr}\n${stdout}`);
    expect(stdout).toContain("native steer identity and persistence contracts passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 40_000);
