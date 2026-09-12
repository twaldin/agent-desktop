import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_PROTOCOL_VERSION, type ChildMessage } from "./protocol";
import { WorkerRuntime } from "./runtime";

async function eventually<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error("Worker lifecycle condition timed out");
    await Bun.sleep(10);
  }
}

for (const version of [2, 3, 19, 20, 21, 29, 32, 33, 34, 35]) test(`an IPC${version} worker is rejected before permission/image/selected-text initialization`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-worker-old-protocol-"));
  const workerPath = join(directory, "worker.ts"), pidFile = join(directory, "pid"), initFile = join(directory, "init");
  await writeFile(workerPath, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
setInterval(()=>{},1000);
process.on('message',message=>{if(message.type==='request'&&message.operation==='init')writeFileSync(${JSON.stringify(initFile)},'unexpected init');});
process.send({type:'ready',version:${version}});
`);
  const runtime = new WorkerRuntime({ workerPath, startupTimeoutMs: 2000, shutdownTimeoutMs: 250,
    environment: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb" } });
  try {
    await expect(runtime.create({ cwd: directory, approvalOverride: "always-ask" })).rejects.toThrow("protocol");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await Bun.file(initFile).exists()).toBe(false);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 5000);

test("the real discovery worker waits for its exact disposal acknowledgement before exiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-worker-dispose-ack-"));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "config.yml"), "extensions: []\n");
  const messages: ChildMessage[] = [];
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url))], {
    env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_CODING_AGENT_DIR: agentDir },
    stdin: "ignore", stdout: "ignore", stderr: "ignore", serialization: "advanced",
    ipc(message) { messages.push(message as ChildMessage); },
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const response = (id: string) => eventually(() => messages.find((message): message is Extract<ChildMessage, { type: "response" }> => message.type === "response" && message.id === id), Boolean);
  try {
    const ready = await eventually(() => messages.find(message => message.type === "ready"), Boolean);
    expect(ready).toEqual({ type: "ready", version: WORKER_PROTOCOL_VERSION });
    child.send({ type: "request", id: "init", operation: "init", args: { mode: "discovery", agentDir } });
    expect((await response("init"))?.ok).toBe(true);
    child.send({ type: "request", id: "models", operation: "listModels", args: { cwd: directory } });
    const models = await response("models");
    expect(models?.ok).toBe(true);
    expect(Array.isArray(models?.value)).toBe(true);
    child.send({ type: "request", id: "dispose", operation: "dispose" });
    expect((await response("dispose"))?.ok).toBe(true);
    child.send({ type: "disposeAck", id: "a-different-disposal" });
    // Intentionally delay the owner: a child-side send() is not evidence of receipt.
    await Bun.sleep(50);
    expect(child.exitCode).toBeNull();
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    child.send({ type: "disposeAck", id: "dispose" });
    expect(await child.exited).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow();
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

// Fault injection exercises the actual parent IPC/lifecycle boundary. This
// deliberately faulty process is not a provider or native cleanup substitute.
for (const mode of ["cleanup-error", "exit-without-receipt", "hang-after-receipt"] as const) {
  test(`worker disposal reports ${mode} and reaps its owned process`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-worker-dispose-failure-"));
    const workerPath = join(directory, "worker.ts"), pidFile = join(directory, "pid"), ackFile = join(directory, "ack");
    await writeFile(workerPath, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
setInterval(()=>{},1000);
process.on('message',message=>{
  if(message.type==='disposeAck') {writeFileSync(${JSON.stringify(ackFile)},message.id); if(${JSON.stringify(mode)}!=='hang-after-receipt')process.exit(1);return;}
  if(message.type!=='request')return;
  if(message.operation==='dispose') {
    if(${JSON.stringify(mode)}==='exit-without-receipt'){process.exit(0);return;}
    process.send({type:'response',id:message.id,ok:${JSON.stringify(mode)}!=='cleanup-error',error:{name:'FixtureCleanupError',message:'Native cleanup contract rejected'}});return;
  }
  process.send({type:'response',id:message.id,ok:true,value:[]});
});
process.send({type:'ready',version:${WORKER_PROTOCOL_VERSION}});
`);
    const runtime = new WorkerRuntime({ workerPath, startupTimeoutMs: 2000, shutdownTimeoutMs: 250,
      environment: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb" } });
    let failure: unknown;
    try {
      await runtime.listModels(directory);
      const pid = Number(await readFile(pidFile, "utf8"));
      const started = Date.now();
      failure = await runtime.dispose().then(() => undefined, error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors as Error[];
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain(mode === "cleanup-error" ? "Native cleanup contract rejected"
        : mode === "exit-without-receipt" ? "before disposal acknowledgement" : "unsuccessfully after disposal acknowledgement");
      expect(Date.now() - started).toBeLessThan(2000);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await runtime.dispose().catch(error => error)).toBe(failure);
      if (mode === "hang-after-receipt") expect(await readFile(ackFile, "utf8")).toBe("3");
    } finally {
      // Dispose is idempotent; preserve its original expected failure above.
      await runtime.dispose().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }, 5000);
}
