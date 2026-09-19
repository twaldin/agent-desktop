import { test, expect } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
test("actual host journal and native worker report, confirm exact credit, and never replay lost outcomes", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-usage-worker-")));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/usage-host.ts", import.meta.url)), directory], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: directory, TERM: "dumb", PI_DISABLE_DOTENV: "1",
        PI_CODING_AGENT_DIR: path.join(directory, "agent"), USAGE_FIXTURE_DIRECTORY: directory }, stdout: "pipe", stderr: "pipe",
    });
    timer = setTimeout(() => child.kill(), 90_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Usage worker fixture failed (${code}):\n${stdout}\n${stderr}`);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ nativeReports: true, nativeCredits: 2, cancelAndChangedCreditRefused: true, explicitReset: true,
      exactFirstAccountCredit: true, duplicatesAndRestartNoReplay: true, unknownBlocksReplacement: true, consumeCalls: 2 });
  } finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
}, 95_000);

test("actual original-session native broker reports retain pool filtering and OAuth overrides", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-usage-broker-")));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/usage-broker.ts", import.meta.url)), directory], {
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: directory, TERM: "dumb", PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent") }, stdout: "pipe", stderr: "pipe",
    });
    timer = setTimeout(() => child.kill(), 45_000);
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Usage broker fixture failed (${code}):\n${stdout}\n${stderr}`);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ brokerReportRoute: true, poolFiltered: true, canonicalProviderReads: 2, runtimeOverrideSuppressedOAuth: true, nativePolicyAndModelGuards: true, consumes: 0 });
  } finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
}, 50_000);
