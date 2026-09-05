import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("native temporary stores, complete provider registry, login callbacks and broker upserts", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-accounts-contract-")));
  const child = Bun.spawn({
    cmd: [process.execPath, fileURLToPath(new URL("./fixtures/native-scenarios.ts", import.meta.url))],
    env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb",
      CONTRACT_DIRECTORY: directory, PI_CODING_AGENT_DIR: path.join(directory, "local-agent") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 40_000);
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error(`Isolated native account contract failed: ${await errors}`);
    expect(await output).toContain("native local and broker account contracts passed");
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); }
}, 50_000);
