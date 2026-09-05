import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function runFixture(fixture: string) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "omp-settings-contract-")));
  const agentDir = path.join(directory, "agent");
  const cwd = path.join(directory, "project");
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\n");
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)), agentDir, cwd], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Temporary native settings contract failed: ${stderr}`);
    expect(stdout).toContain("native settings contracts passed");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("pinned native settings descriptors, persistent edits, conflicts and secret redaction", () => runFixture("settings-scenario.ts"), 60_000);
test("settings HTTP validates catalog targets and writes only native state through production backends", () => runFixture("http-scenario.ts"), 60_000);
test("native model definitions preserve secrets, reject invalid edits, reload registry and lock concurrent clients", () => runFixture("model-definitions-scenario.ts"), 90_000);
test("duplicate native model IDs retain per-index secrets and reject ambiguous replacement or stale reorder edits", () => runFixture("duplicate-models-scenario.ts"), 60_000);
