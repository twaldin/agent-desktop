import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime, type WorkerRuntimeOptions } from "./runtime";

test("the actual native child retains its original reset epoch with its recovery endpoint", async () => {
  const root = await realpath(await mkdtemp("/tmp/native-reset-reconnect-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await Promise.all([agentDir, cwd].map(directory => mkdir(directory)));
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\n");
  const environment = { HOME: root, PATH: process.env.PATH, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", TERM: "dumb" };
  const seed = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./fixtures/seed-auth.ts", import.meta.url)), agentDir, "key"], { env: environment, stdout: "pipe", stderr: "pipe" });
  const [seedCode, seedError] = await Promise.all([seed.exited, new Response(seed.stderr).text()]);
  if (seedCode !== 0) throw new Error(`Temporary credential setup failed: ${seedError}`);
  let original: Parameters<NonNullable<WorkerRuntimeOptions["createResetPolicyOwner"]>>[0] | undefined;
  const runtime = new WorkerRuntime({ agentDir, environment,
    workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    createResetPolicyOwner: context => {
      original = context;
      return { async handle() { throw new Error("Idle native child must not request reset admission"); },
        beginClose() {}, workerLost() {}, workerExited() {}, async drain() {} };
    },
  });
  try {
    const session = await runtime.create({ cwd, model: { provider: "openai", id: "gpt-5.4-mini" } });
    const endpoint = await session.enableBrowserRecovery!(path.join(root, "worker.sock"), randomBytes(32).toString("hex"), randomUUID());
    expect(original).toBeDefined();
    expect(endpoint.pid).toBe(session.workerPid);
    expect(endpoint.resetPolicy).toEqual({ workerEpoch: original!.workerEpoch, rootSessionId: session.id,
      sessionFile: session.sessionFile, cwd: session.cwd });
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
