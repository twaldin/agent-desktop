import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("actual native Plan controller prepares original plan and validated annotation editor inputs", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-external-editor-native-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath,
      fileURLToPath(new URL("./fixtures/plan-external-editor-native.ts", import.meta.url)), directory], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: path.join(directory, "tmp"), TERM: "dumb",
        PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    deadline = setTimeout(() => child.kill(), 30_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native Plan external-editor fixture failed (${code}):\n${stdout}\n${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result).toEqual({ blockedFetches: 0, configUnchanged: true, extension: ".md", originalContent: true,
      annotationValidated: true, annotationOnlyRevisionChanged: true, staleOwnerRefused: true,
      externalBytesRefused: true, reopenedContent: true });
  } finally {
    clearTimeout(deadline);
    await rm(directory, { recursive: true, force: true });
  }
}, 35_000);
