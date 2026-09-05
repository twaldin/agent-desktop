import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function run(mode: string = "auto") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-thinking-contract-")));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/thinking-persistence.ts", import.meta.url)), directory, mode], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_CODING_AGENT_DIR: path.join(directory, ".omp", "agent") },
      stdout: "pipe", stderr: "pipe",
    });
    deadline = setTimeout(() => child.kill(), 20_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Native thinking fixture failed: ${stderr}`);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.blockedFetches).toBe(0);
    expect(result.configUnchanged).toBe(true);
    return result;
  } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }); }
}

test("new native Mini auto selection survives close and reopen despite a default role :max", async () => {
  const result = await run();
  expect(result.before.thinkingLevel).toBe("auto");
  expect(result.before.model).toEqual({ provider: "openai-codex", id: "gpt-5.4-mini" });
  expect(result.after.thinkingLevel).toBe("auto");
  expect(result.after.id).toBe(result.before.id);
  expect(result.after.model).toEqual(result.before.model);
  expect(result.before.thinkingEntries).toHaveLength(1);
  expect(result.before.thinkingEntries[0]).toMatchObject({ thinkingLevel: "high", configured: "auto" });
  expect(result.after.thinkingEntries).toEqual(result.before.thinkingEntries);
}, 30_000);

test("unchanged high native classification fallback twice retains auto without duplicate receipts", async () => {
  const result = await run("unchanged");
  expect(result.before.thinkingLevel).toBe("auto");
  expect(result.resolutions).toEqual(Array.from({ length: 2 }, () => ({ type: "thinking_level_changed", thinkingLevel: "high", configured: "auto", resolved: "high" })));
  expect(result.dropped).toEqual(Array(2).fill("Isolated unchanged auto thinking contract"));
  expect(result.messageCount).toBe(0);
  expect(result.after.thinkingLevel).toBe("auto");
  expect(result.after.thinkingEntries).toEqual(result.before.thinkingEntries);
  expect(result.after.thinkingEntries).toHaveLength(1);
}, 30_000);

test.each(["concrete", "role"])("native concrete selection remains unchanged with one native entry: %s", async mode => {
  const result = await run(mode);
  const level = mode === "concrete" ? "low" : "xhigh";
  expect(result.before.thinkingLevel).toBe(level);
  expect(result.after.thinkingLevel).toBe(level);
  expect(result.before.thinkingEntries).toHaveLength(1);
  expect(result.before.thinkingEntries[0]).toMatchObject({ thinkingLevel: level, configured: null });
  expect(result.after.thinkingEntries).toEqual(result.before.thinkingEntries);
}, 30_000);

test("later explicit thinking edits retain native receipts and repeated selections add none", async () => {
  const result = await run("edits");
  expect(result.edits.map((state: { thinkingLevel: string }) => state.thinkingLevel)).toEqual(["auto", "xhigh", "auto", "auto", "low"]);
  expect(result.edits.map((state: { thinkingEntries: unknown[] }) => state.thinkingEntries.length)).toEqual([1, 2, 3, 3, 4]);
  expect(result.edits[2].thinkingEntries[2]).toMatchObject({ thinkingLevel: "high", configured: "auto" });
  expect(result.after.thinkingLevel).toBe("low");
  expect(result.after.thinkingEntries).toEqual(result.edits[4].thinkingEntries);
}, 30_000);

test("existing native logs without a thinking receipt retain native restore semantics without invented intent", async () => {
  const result = await run("legacy");
  expect(result.before.thinkingLevel).toBe("auto");
  expect(result.before.thinkingEntries).toEqual([]);
  expect(result.after.thinkingLevel).toBe("xhigh");
  expect(result.after.id).toBe(result.before.id);
  expect(result.after.thinkingEntries).toEqual([]);
}, 30_000);
