import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

test("owning native worker rejects idle and interrupt-racing steers and cancels queued input on dispose (controlled transport)", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-steer-worker-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/steer-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, STEER_CONTRACT_GATES: gates, TERM: "dumb" } });
  const started = async (call: number) => {
    const file = Bun.file(path.join(gates, `${call}.started`)), deadline = Date.now() + 7000;
    while (!await file.exists() && Date.now() < deadline) await Bun.sleep(5);
    expect(await file.exists()).toBe(true);
  };
  try {
    const session = await runtime.create({ cwd, interactions: true });
    expect((await session.steer("Idle input must not start a turn")).kind).toBe("not-recorded");
    const model = { provider: "steer-contract", id: "controlled" };
    const run = session.startPrompt("Controlled native interrupt race", { model }); await run.accepted; await started(1);
    // No app override: compare against the actual native default, not an absent
    // catalog field. Rejected intent must not enter the native queue.
    const differentDefault = await session.steer("Wrong permission under native default", "always-ask");
    expect(differentDefault.kind).toBe("not-recorded");
    if (differentDefault.kind === "not-recorded") expect(differentDefault.reason).toContain("different native permission");
    // Concurrent real RPC requests: a stale host streaming snapshot must not
    // authorize a steer while the native abort is unwinding or after it ends.
    const stopping = session.abort(), late = session.steer("Late input racing native abort");
    expect((await late).kind).toBe("not-recorded"); await stopping; await run.completion;
    expect((await session.steer("Input after native abort")).kind).toBe("not-recorded");
    await Bun.sleep(50); expect(await Bun.file(path.join(gates, "2.started")).exists()).toBe(false);
    await session.setApprovalOverride("always-ask", (await session.getControls()).revision);
    const resumed = session.startPrompt("Controlled native disposal", { model }); await resumed.accepted; await started(2);
    expect((await session.steer("Wrong permission under saved override", "yolo")).kind).toBe("not-recorded");
    let settled = false;
    const queued = session.steer("Queued input must survive native disposal", "always-ask").then(receipt => { settled = true; return receipt; });
    await Bun.sleep(50); expect(settled).toBe(false);
    const disposing = session.dispose();
    expect((await queued).kind).toBe("not-recorded"); await disposing; await resumed.completion;
    const lines = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const userTexts = lines.filter(entry => entry.message?.role === "user").map(entry => entry.message.content[0].text);
    expect(userTexts).toEqual(["Controlled native interrupt race", "Controlled native disposal"]);
    expect(await Bun.file(path.join(gates, "3.started")).exists()).toBe(false);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
