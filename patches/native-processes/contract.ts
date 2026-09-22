// Actual private broker/client/process contract. Does not use a user's broker,
// completion subscription, profile or providers. SOURCE selects an authored
// package copy; this is not a clean installed-package acceptance test.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NativeSessionProcesses } from "../../apps/host/src/omp/session-processes";

const source = path.resolve(process.argv[2]!);
if (process.argv[3] === "--broker") {
  const { startDaemonBrokerFromEnvironment } = await import(pathToFileURL(path.join(source, "src/launch/broker.ts")).href);
  await startDaemonBrokerFromEnvironment();
} else {
  const root = await realpath(await mkdtemp("/tmp/ad-process-"));
  const project = path.join(root, "project"), runtimeDir = path.join(root, "scopes", "test");
  await Promise.all([project, runtimeDir, path.join(root, "home")].map(p => mkdir(p, { recursive: true })));
  await writeFile(path.join(runtimeDir, "broker.token"), "private-native-process-contract-token", { mode: 0o600 });
  const { createDaemonBrokerClient } = await import(pathToFileURL(path.join(source, "src/launch/client.ts")).href);
  const { parseDaemonWireRequest, parseDaemonRpcResult } = await import(pathToFileURL(path.join(source, "src/launch/protocol.ts")).href);
  const facts: string[] = [], pids: number[] = [];
  const childEnv = { PATH: process.env.PATH, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "home", "agent"),
    OMP_DAEMON_PROJECT_DIR: project, OMP_DAEMON_RUNTIME_DIR: runtimeDir, OMP_DAEMON_IDLE_GRACE_MS: "1000", TERM: "dumb" };
  let broker: Bun.Subprocess<"ignore", "pipe", "pipe">, stderr: Promise<string>, stdout: Promise<string>;
  let client: Awaited<ReturnType<typeof createDaemonBrokerClient>>;
  async function boot() {
    broker = Bun.spawn([process.execPath, import.meta.path, source, "--broker"], { cwd: project, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    pids.push(broker.pid);
    stdout = new Response(broker.stdout).text(); stderr = new Response(broker.stderr).text();
    const deadline = Date.now() + 8000;
    while (!await Bun.file(path.join(runtimeDir, "broker.pid")).exists() || !await (await import("node:fs/promises")).stat(path.join(runtimeDir, "broker.sock")).then(() => true, () => false)) {
      if (broker.exitCode !== null) throw new Error(`Private broker failed startup: ${await stderr}`);
      if (Date.now() >= deadline) throw new Error("Private broker startup deadline expired");
      await Bun.sleep(10);
    }
    client = await createDaemonBrokerClient(project, { runtimeDir });
    assert.equal((await client.request({ op: "ping" })).projectDir, project);
  }
  const script = 'console.log("READY");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);for await(const b of Bun.stdin.stream())console.log("INPUT:"+new TextDecoder().decode(b).trim());';
  const spec = { name: "contract", application: process.execPath, args: ["-e", script], cwd: project, env: {}, pty: false,
    ready: { log: "READY", timeoutMs: 2000 }, restart: "no", persist: false, detached: false };
  const observe = async () => { const v = await client.request({ op: "observe" }); assert.equal(v.op, "observe"); return v; };
  const guarded = (target: unknown, operation: unknown) => client.request({ op: "guarded", target, operation });
  const logOperation = { op: "logs", name: "contract", lines: 100, head: false, follow: false, timeoutMs: 1000 };
  try {
    await boot();
    assert.equal((await observe()).daemons.length, 0);
    const initial = await client.request({ op: "start", spec, owner: "original-session" });
    pids.push(initial.daemon.pid); assert.equal(initial.readyTimedOut, false);
    const first = (await observe()).daemons[0];
    assert.equal(first.target.id, initial.daemon.id); assert.equal(first.daemon.owner, "original-session");
    facts.push("native readiness and original-owner observation");
    const log = await guarded(first.target, logOperation); assert.match(log.result.text, /READY/);
    const adapter = new NativeSessionProcesses({ nativeSessionId: "session", epoch: "worker", projectDir: project }, () => {},
      () => createDaemonBrokerClient(project, { runtimeDir }));
    try {
      const result = await adapter.request({ action: "read" });
      assert.equal(result.action, "read");
      if (result.action !== "read") throw new Error("Expected native process rows");
      assert.equal(result.snapshot.rows[0]!.target.id, initial.daemon.id);
      assert.equal(result.snapshot.rows[0]!.nativeOwner, "original-session");
      const logs = await adapter.request({ action: "logs", owner: adapter.owner, target: first.target });
      assert.equal(logs.action, "logs");
      if (logs.action !== "logs") throw new Error("Expected native process logs");
      assert.match(logs.text, /READY/);
    } finally { await adapter.dispose(); }
    assert.equal((await observe()).daemons[0].daemon.pid, initial.daemon.pid);
    facts.push("actual session adapter reads project process/logs and closes only its independent client");
    const input = { op: "send", name: "contract", data: "hello\n" };
    const sending = guarded(first.target, input);
    input.data = "mutated-after-dispatch\n";
    await sending;
    const until = Date.now() + 2000;
    while (!String((await guarded(first.target, logOperation)).result.text).includes("INPUT:hello")) { assert.ok(Date.now() < until); await Bun.sleep(10); }
    assert.doesNotMatch((await guarded(first.target, logOperation)).result.text, /mutated-after-dispatch/);
    facts.push("guarded native stdin retains original input across connection await");
    const restarted = await guarded(first.target, { op: "restart", name: "contract" });
    pids.push(restarted.result.daemon.pid); assert.equal(restarted.target.generation, first.target.generation + 1);
    await assert.rejects(() => guarded(first.target, { op: "stop", name: "contract", timeoutMs: 1000 }), /observed process or broker has changed/);
    assert.equal((await observe()).daemons[0].daemon.pid, restarted.result.daemon.pid);
    facts.push("restart changes generation and stale stop cannot stop replacement");
    const latest = (await observe()).daemons[0];
    const pendingLog = guarded(latest.target, { ...logOperation, follow: true, cursor: Number.MAX_SAFE_INTEGER, timeoutMs: 1000 })
      .then((value: { target: unknown }) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    const secondRestart = await guarded(latest.target, { op: "restart", name: "contract" });
    pids.push(secondRestart.result.daemon.pid);
    const readOutcome = await pendingLog;
    if (readOutcome.ok) {
      // A follow-read can settle legitimately on original exit before restart.
      assert.deepEqual(readOutcome.value.target, latest.target);
      facts.push("concurrent follow read settled with original target before restart");
    } else {
      assert.match(String(readOutcome.error), /observed process or broker has changed/);
      facts.push("concurrent follow read rejected stale generation");
    }
    const stoppedTarget = (await observe()).daemons[0].target;
    const stopped = await guarded(stoppedTarget, { op: "stop", name: "contract", timeoutMs: 1000 });
    assert.equal(stopped.result.daemon.state, "exited");
    const replacement = await client.request({ op: "start", spec, owner: "replacement-session" });
    pids.push(replacement.daemon.pid); assert.notEqual(replacement.daemon.id, stoppedTarget.id);
    await assert.rejects(() => guarded(stoppedTarget, { op: "send", name: "contract", data: "must-not-send\n" }), /observed process or broker has changed/);
    assert.doesNotMatch((await client.request(logOperation)).text, /must-not-send/);
    facts.push("same-name replacement rejects original input");
    // The normal agent completion subscriber remains the sole delivery owner.
    // A second desktop client can inspect and close while delivery is held.
    const ownerClient = await createDaemonBrokerClient(project, { runtimeDir });
    const completion = Promise.withResolvers<{ completionId: string; daemon: { id: string } }>();
    const delivered = Promise.withResolvers<void>(), allowDelivery = Promise.withResolvers<void>();
    let deliveries = 0;
    const unsubscribe = ownerClient.onCompletion("completion-owner", async (notification: { completionId: string; daemon: { id: string } }) => {
      deliveries++; completion.resolve(notification); await allowDelivery.promise; delivered.resolve();
    });
    let observer: NativeSessionProcesses | undefined;
    try {
      const completed = await ownerClient.request({ op: "start", owner: "completion-owner", spec: { ...spec, name: "completion",
        args: ["-e", 'console.log("READY");setTimeout(()=>process.exit(0),150);'] } });
      if (completed.daemon.pid !== undefined) pids.push(completed.daemon.pid);
      const notification = await Promise.race([completion.promise, Bun.sleep(3000).then(() => { throw new Error("Original completion subscriber did not receive its process"); })]);
      assert.equal(notification.daemon.id, completed.daemon.id);
      observer = new NativeSessionProcesses({ nativeSessionId: "viewing-session", epoch: "worker", projectDir: project }, () => {},
        () => createDaemonBrokerClient(project, { runtimeDir }));
      const viewed = await observer.request({ action: "read" });
      assert.equal(viewed.action, "read");
      if (viewed.action !== "read") throw new Error("Expected process observation");
      assert.equal(viewed.snapshot.rows.find(row => row.target.name === "completion")?.nativeOwner, "completion-owner");
      await observer.dispose();
      const metadataPath = path.join(runtimeDir, "daemons", "completion", "meta.json");
      const pending = await Bun.file(metadataPath).json();
      assert.equal(pending.pendingCompletions[0].completionId, notification.completionId);
      allowDelivery.resolve(); await delivered.promise;
      const ackDeadline = Date.now() + 2000;
      while ((await Bun.file(metadataPath).json()).pendingCompletions.length !== 0) {
        assert.ok(Date.now() < ackDeadline, "Original owner acknowledgement was not persisted"); await Bun.sleep(10);
      }
      assert.equal(deliveries, 1);
      facts.push("desktop observation/disposal preserves original completion subscription and native acknowledgement");
    } finally { allowDelivery.resolve(); await observer?.dispose(); unsubscribe(); ownerClient.close(); }
    const oldBrokerTarget = (await observe()).daemons[0].target;
    await client.request({ op: "stop", name: "contract", timeoutMs: 1000 });
    await client.request({ op: "shutdown" }); client.close();
    assert.equal(await broker!.exited, 0); await Promise.all([stdout!, stderr!]);
    await boot();
    assert.notEqual((await observe()).brokerId, oldBrokerTarget.brokerId);
    await assert.rejects(() => guarded(oldBrokerTarget, logOperation), /observed process or broker has changed/);
    facts.push("broker restart invalidates saved target despite retained metadata");
    assert.throws(() => parseDaemonWireRequest({ id: "x", token: "x", operation: { op: "guarded", target: oldBrokerTarget, operation: { op: "shutdown" } } }), /named process/);
    assert.throws(() => parseDaemonWireRequest({ id: "x", token: "x", operation: { op: "guarded", target: oldBrokerTarget, operation: { ...logOperation, name: "foreign" } } }), /name does not match/);
    assert.throws(() => parseDaemonRpcResult({ op: "guarded", target: oldBrokerTarget, operation: logOperation }, { op: "guarded", target: { ...oldBrokerTarget, brokerId: "foreign" }, result: log.result }), /identity mismatch/);
    assert.throws(() => parseDaemonRpcResult({ op: "guarded", target: first.target, operation: logOperation }, { ...log, result: { ...log.result, op: "stop" } }), /operation mismatch/);
    facts.push("wire refuses unowned operations, aliases and foreign receipt");
    if (process.argv[3]) {
      const baseline = path.resolve(process.argv[3]);
      const { parseDaemonWireRequest: beforeParse } = await import(pathToFileURL(path.join(baseline, "src/launch/protocol.ts")).href);
      for (const operation of [{ op: "observe" }, { op: "guarded", target: first.target, operation: logOperation }]) {
        assert.throws(() => beforeParse({ id: "old-capability", token: "private-fixture", operation }), /operation/i);
      }
      facts.push("actual baseline wire parser rejects both new capabilities; no name-only fallback");
    }
  } finally {
    if (client!) {
      try { await client.request({ op: "shutdown" }); } catch { /* The raw exit and stderr below retain failed broker cleanup. */ }
      client.close();
    }
    if (broker!) {
      const code = await Promise.race([broker.exited, Bun.sleep(6000).then(() => undefined)]);
      if (code === undefined) { broker.kill("SIGTERM"); await broker.exited; throw new Error("Private broker did not drain in cleanup"); }
      const [out, err] = await Promise.all([stdout!, stderr!]);
      assert.equal(code, 0, err); assert.equal(err, "", out);
    }
    const survivors = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    await writeFile(path.join(root, "receipt.json"), JSON.stringify({ root, source, facts, pids, survivors }, null, 2));
    assert.deepEqual(survivors, []);
    console.log(JSON.stringify({ root, facts, survivors }));
  }
}
