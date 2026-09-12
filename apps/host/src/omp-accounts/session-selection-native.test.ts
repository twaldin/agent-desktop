import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "../omp-workers/runtime";

test("actual native worker account tokens bind model ABA, resume and session-local pins", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "accounts-model-native-"))), agentDir = join(directory, "agent"), cwd = join(directory, "project");
  await mkdir(agentDir); await mkdir(cwd); await writeFile(join(agentDir, "config.yml"), "extensions: []\n");
  const environment = { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" };
  const seed = Bun.spawn([process.execPath, fileURLToPath(new URL("../omp-workers/fixtures/seed-auth.ts", import.meta.url)), agentDir, "oauth"], { env: environment, stdout: "pipe", stderr: "pipe" });
  const seedExit = await seed.exited; if (seedExit) throw new Error(`Disposable auth setup failed: ${await new Response(seed.stderr).text()}`);
  const runtime = new WorkerRuntime({ agentDir, environment, workerPath: fileURLToPath(new URL("../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)), startupTimeoutMs: 30_000 });
  try {
    const models = (await runtime.listModels(cwd)).filter(model => model.provider === "openai");
    const one = models[0]!, two = models.find(model => model.id !== one.id)!; expect(Boolean(two)).toBe(true);
    const first = await runtime.create({ cwd, model: one }), second = await runtime.create({ cwd, model: one });
    const original = await first.listAccountChoices(), independent = await second.listAccountChoices(); expect(original.selection?.model).toEqual({ provider: one.provider, id: one.id });
    const a = original.accounts[0]!, b = original.accounts[1]!;
    const pinned = await first.pinAccount(a.credentialId, original.selection);
    expect(pinned.accounts.find(account => account.active)?.credentialId).toBe(a.credentialId);
    await second.pinAccount(b.credentialId, independent.selection);
    expect((await first.listAccountChoices()).accounts.find(account => account.active)?.credentialId).toBe(a.credentialId);
    await first.setModel(two); await first.setModel(one);
    await expect(first.releaseAccountForReselection(pinned.selection)).rejects.toThrow("selection changed");
    expect((await first.listAccountChoices()).accounts.find(account => account.active)?.credentialId).toBe(a.credentialId);
    const fresh = await first.listAccountChoices(), sessionFile = first.sessionFile;
    await first.dispose(); const resumed = await runtime.open({ sessionFile }); expect(resumed.id).toBe(first.id);
    await expect(resumed.pinAccount(b.credentialId, fresh.selection)).rejects.toThrow("selection changed");
    const restored = await resumed.listAccountChoices(); expect(restored.accounts.find(account => account.active)?.credentialId).toBe(a.credentialId);
    expect((await resumed.releaseAccountForReselection(restored.selection)).accounts.some(account => account.active)).toBe(false);
    expect((await second.listAccountChoices()).accounts.find(account => account.active)?.credentialId).toBe(b.credentialId);
    expect(JSON.stringify(await resumed.listAccountChoices())).not.toMatch(/contract-access|contract-refresh/);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 90_000);
