// Production WorkerRuntime/entry/OmpRuntime and broker/client over disposable
// local sockets and real child processes. No provider requests or user profile.
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[3] === "--broker") {
  const { startDaemonBrokerFromEnvironment } = await import("@oh-my-pi/pi-coding-agent/launch/broker");
  await startDaemonBrokerFromEnvironment();
} else {
  const root = process.argv[2]!;
  assert.equal(process.env.HOME, root);
  const blocked: string[] = [], allowedOrigins = new Set<string>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (allowedOrigins.has(new URL(url).origin)) return originalFetch(input, init);
    blocked.push(url); throw new Error("No external network allowed in process fixture");
  }, { preconnect() {} }) as typeof fetch;
  const project = path.join(root, "a"), destination = path.join(root, "b"), agentDir = path.join(root, "agent");
  await Promise.all([project, destination, agentDir].map(p => mkdir(p, { recursive: true })));
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\nmemory:\n  enabled: false\nmodelRoles:\n  default: [processes-fixture/base]\ntools:\n  approvalMode: yolo\n");
  await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "processes-fixture": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [{ id: "base", name: "Unused process fixture model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const { WorkerRuntime } = await import("../../omp-workers/runtime");
  const { createDaemonBrokerClient } = await import("@oh-my-pi/pi-coding-agent/launch/client");
  const { getDaemonRuntimeDir } = await import("@oh-my-pi/pi-utils");
  const environment = { HOME: root, PATH: process.env.PATH, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", TERM: "dumb", NO_COLOR: "1" };
  const runtime = new WorkerRuntime({ agentDir, environment, workerPath: fileURLToPath(new URL("../../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)) });
  const brokers: Array<{ child: Bun.Subprocess; output: Promise<string[]>; client: Awaited<ReturnType<typeof createDaemonBrokerClient>> }> = [];
  const pids: number[] = [], facts: string[] = [];
  async function until<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) { const value = await read(); if (value !== undefined) return value; assert.ok(Date.now() < deadline, message); await Bun.sleep(10); }
  }
  async function boot(cwd: string) {
    const runtimeDir = getDaemonRuntimeDir(cwd);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "broker.token"), "private-process-worker-fixture", { mode: 0o600 });
    const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, root, "--broker"], { env: { ...environment, OMP_DAEMON_PROJECT_DIR: cwd, OMP_DAEMON_RUNTIME_DIR: runtimeDir, OMP_DAEMON_IDLE_GRACE_MS: "1000" }, stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const client = await createDaemonBrokerClient(cwd);
    brokers.push({ child, output, client }); pids.push(child.pid);
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Broker startup failed: ${(await output).join("\n")}`);
      return await stat(path.join(runtimeDir, "broker.sock")).then(() => true, () => undefined);
    }, "Broker socket did not open");
    const ping = await client.request({ op: "ping" });
    if (ping.op !== "ping") throw new Error("Expected ping");
    assert.equal(ping.projectDir, cwd);
    return client;
  }
  try {
    const client = await boot(project); await boot(destination);
    const session = await runtime.create({ cwd: project, model: { provider: "processes-fixture", id: "base" } });
    const empty = await session.nativeProcesses({ action: "read" });
    assert.equal(empty.action, "read"); if (empty.action !== "read") throw new Error("Expected read");
    assert.equal(empty.snapshot.owner.nativeSessionId, session.id); assert.equal(empty.snapshot.owner.projectDir, project); assert.equal(empty.snapshot.rows.length, 0);
    const started = await client.request({ op: "start", owner: session.id, spec: { name: "fixture", application: process.execPath, args: ["-e", 'console.log("READY");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);for await(const b of Bun.stdin.stream())console.log("INPUT:"+new TextDecoder().decode(b).trim());'], cwd: project, env: {}, pty: false, ready: { log: "READY", timeoutMs: 2000 }, restart: "no", persist: false, detached: false } });
    if (started.op !== "start") throw new Error("Expected start");
    const observe = async () => { const result = await client.request({ op: "observe" }); if (result.op !== "observe") throw new Error("Expected observation"); return result; };
    if (started.daemon.pid) pids.push(started.daemon.pid);
    const read = await session.nativeProcesses({ action: "read", owner: empty.snapshot.owner });
    assert.equal(read.action, "read"); if (read.action !== "read") throw new Error("Expected read");
    const { owner } = read.snapshot, target = read.snapshot.rows[0]!.target;
    assert.equal(target.id, started.daemon.id);
    const logs = await session.nativeProcesses({ action: "logs", owner, target });
    assert.equal(logs.action, "logs"); if (logs.action !== "logs") throw new Error("Expected logs");
    assert.match(logs.text, /READY/);
    await session.nativeProcesses({ action: "input", operationId: "input-0001", owner, target, text: "original-only\n" });
    await until(async () => { const result = await client.request({ op: "logs", name: "fixture", lines: 100, head: false, follow: false, timeoutMs: 1000 }); if (result.op !== "logs") throw new Error("Expected logs"); return result.text.includes("INPUT:original-only") ? true : undefined; }, "Native stdin did not arrive");
    facts.push("actual worker read/log/input on original broker and process");
    const restarted = await session.nativeProcesses({ action: "restart", operationId: "restart-1", owner, target });
    assert.equal(restarted.action, "mutation"); if (restarted.action !== "mutation") throw new Error("Expected mutation");
    assert.equal(restarted.row.target.generation, target.generation + 1);
    if (restarted.row.pid) pids.push(restarted.row.pid);
    await assert.rejects(session.nativeProcesses({ action: "stop", operationId: "stale-stop", owner, target }));
    assert.equal((await observe()).daemons[0]!.target.generation, restarted.row.target.generation);
    facts.push("restart advances generation and stale stop cannot stop replacement");
    const moved = await session.moveSession(destination);
    assert.equal(moved.cwd, destination);
    await assert.rejects(session.nativeProcesses({ action: "read", owner }));
    const fresh = await session.nativeProcesses({ action: "read" });
    assert.equal(fresh.action, "read"); if (fresh.action !== "read") throw new Error("Expected read");
    assert.equal(fresh.snapshot.owner.projectDir, destination); assert.notEqual(fresh.snapshot.owner.epoch, owner.epoch); assert.equal(fresh.snapshot.rows.length, 0);
    assert.equal((await observe()).daemons[0]!.daemon.state, "ready");
    facts.push("explicit task move retires old view without killing original process");
    await session.dispose();
    await assert.rejects(session.nativeProcesses({ action: "read" }));
    assert.equal((await observe()).daemons[0]!.daemon.state, "ready");
    facts.push("session disposal closes observer only, project process remains live");
    const reopened = await runtime.open({ sessionFile: moved.sessionFile });
    const afterReopen = await reopened.nativeProcesses({ action: "read" });
    assert.equal(afterReopen.action, "read"); if (afterReopen.action !== "read") throw new Error("Expected read");
    assert.equal(reopened.id, session.id); assert.notEqual(afterReopen.snapshot.owner.epoch, fresh.snapshot.owner.epoch);
    await assert.rejects(reopened.nativeProcesses({ action: "read", owner: fresh.snapshot.owner }));
    facts.push("same-session reopen uses a new epoch, saved original view stays stale");
    await reopened.dispose();
    const { startHost } = await import("../../server");
    const { requestSessionProcesses } = await import("../../../../desktop/src/main/session-processes-transport");
    const { SESSION_ACTIVITY_OWNER_HEADER } = await import("../../../../../packages/shared/src/session-activity");
    const options = { dataDirectory: path.join(root, "host"), agentDirectory: agentDir, discoveryDirectory: project, tailscale: false,
      port: 0, workerPath: fileURLToPath(new URL("../../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)) };
    let host = await startHost(options);
    try {
      allowedOrigins.add(host.connection.origin);
      const endpoint = { origin: host.connection.origin, hostId: host.store.host.id, token: host.connection.token };
      const denied = await fetch(`${endpoint.origin}/v1/sessions/unknown/processes`, { method: "POST", headers: { [SESSION_ACTIVITY_OWNER_HEADER]: endpoint.hostId }, body: '{"action":"read"}' });
      assert.equal(denied.status, 401); await denied.body?.cancel();
      const create = await fetch(`${endpoint.origin}/v1/commands`, { method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "process-host-session", command: { type: "session.create", projectId: null, cwd: project, model: { provider: "processes-fixture", id: "base" } } }) });
      assert.equal(create.status, 200);
      const created = await create.json() as { ok: boolean; value?: { id: string }; error?: unknown };
      assert.equal(created.ok, true, JSON.stringify(created.error)); assert.ok(created.value?.id);
      const id = created.value.id;
      const observed = (await requestSessionProcesses(endpoint, id, { action: "read" })).result;
      assert.equal(observed.action, "read"); if (observed.action !== "read") throw new Error("Expected read");
      const mutation = { action: "input" as const, operationId: "durable-input-1", owner: observed.snapshot.owner, target: observed.snapshot.rows[0]!.target, text: "durable-once\n" };
      const first = (await requestSessionProcesses(endpoint, id, mutation)).result;
      assert.equal(first.action, "mutation"); if (first.action !== "mutation") throw new Error("Expected receipt");
      assert.equal(first.receipt.status, "completed");
      assert.deepEqual((await requestSessionProcesses(endpoint, id, mutation)).result, first);
      await assert.rejects(requestSessionProcesses(endpoint, id, { ...mutation, text: "changed" }));
      await until(async () => { const logs = await client.request({ op: "logs", name: "fixture", lines: 100, head: false, follow: false, timeoutMs: 1000 });
        if (logs.op !== "logs") throw new Error("Expected logs");
        const count = logs.text.split("INPUT:durable-once").length - 1; assert.ok(count <= 1); return count === 1 ? true : undefined;
      }, "Durable input not delivered");
      facts.push("authenticated real host/desktop transport/worker/broker input admits and finishes once");
      await host.stop();
      host = await startHost(options); allowedOrigins.add(host.connection.origin);
      const reconnected = { origin: host.connection.origin, hostId: host.store.host.id, token: host.connection.token };
      assert.deepEqual((await requestSessionProcesses(reconnected, id, { action: "receipt", operationId: mutation.operationId })).result, { action: "receipt", receipt: first.receipt });
      assert.deepEqual((await requestSessionProcesses(reconnected, id, mutation)).result, first);
      await assert.rejects(requestSessionProcesses(reconnected, id, { action: "read" }), /Open the original session/);
      facts.push("host reopen returns durable receipt without loading worker or replaying input");
    } finally { await host.stop(); }
  } finally {
    const errors: unknown[] = [];
    try { await runtime.dispose(); } catch (error) { errors.push(error); }
    for (const broker of brokers.reverse()) {
      try { await broker.client.request({ op: "shutdown" }); } catch (error) { errors.push(error); }
      broker.client.close();
      const deadline = setTimeout(() => broker.child.kill(), 8000);
      const code = await broker.child.exited; clearTimeout(deadline);
      const output = await broker.output;
      if (code !== 0) errors.push(new Error(`Private broker exit ${code}: ${output.join("\n")}`));
    }
    const survivors = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (survivors.length) errors.push(new Error(`Owned fixture process survivors: ${survivors.join(",")}`));
    console.log(JSON.stringify({ facts, blocked, pids, survivors, cleanupErrors: errors.map(String) }));
    if (errors.length) throw new AggregateError(errors, "Native process fixture cleanup failed");
  }
  assert.deepEqual(blocked, []);
}
