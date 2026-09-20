import { afterEach, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeResetPolicy } from "../native-reset-policy";
import { ResetAccountAdmissions } from "../session-reset-admission";
import { HostStore } from "../store";
import { NativeResetPolicyWorkerOwner } from "./reset-policy-owner";
import { WorkerClient, type WorkerRuntimeOptions } from "./runtime";
import type { WorkerReconnectEndpoint } from "./reconnect-wire";
import type { ResetPolicyWireRequest, ResetPolicyWireResult } from "./reset-policy-wire";

type Notice = { type: string; endpoint?: WorkerReconnectEndpoint; request?: ResetPolicyWireRequest; reply?: ResetPolicyWireResult; error?: string; storeClosed?: boolean; storeReadable?: boolean; interaction?: { id: string } };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function control(root: string, command: { op: string; route?: string; count?: number }): Promise<any> {
  const { promise, resolve, reject } = Promise.withResolvers<any>();
  const socket = createConnection(path.join(root, "control.sock")); let text = "";
  socket.once("error", reject);
  socket.once("connect", () => socket.write(JSON.stringify(command) + "\n"));
  socket.on("data", chunk => { text += chunk.toString(); });
  socket.once("end", () => {
    try { const reply = JSON.parse(text); reply.ok ? resolve(reply.value) : reject(new Error(reply.error)); }
    catch (error) { reject(error); }
  });
  return promise;
}

async function startHost(options: { holdAdmission?: boolean; failDrain?: boolean; mode?: "yes" | "unset" } = {}) {
  const root = await realpath(await mkdtemp("/tmp/reset-real-"));
  await Promise.all(["agent", "project"].map(name => mkdir(path.join(root, name))));
  await writeFile(path.join(root, "agent", "config.yml"), `extensions: []\ncodexResets:\n  autoRedeem: ${options.mode ?? "yes"}\n  minBlockedMinutes: 30\n  keepCredits: 0\n  salvageHorizonHours: 24\n`);
  const notices: Notice[] = [], listeners = new Set<() => void>();
  const environment = { HOME: root, PATH: process.env.PATH, TMPDIR: root, TERM: "dumb", NO_COLOR: "1", PI_DISABLE_DOTENV: "1",
    PI_CODING_AGENT_DIR: path.join(root, "agent"), RESET_RECONNECT_FIXTURE_ROOT: root,
    ...(options.failDrain ? { RESET_RECONNECT_FAIL_DRAIN: "1" } : {}),
    ...(options.holdAdmission ? { RESET_RECONNECT_HOLD_ADMISSION: "1" } : {}) };
  const host = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./fixtures/reset-policy-reconnect-host.ts", import.meta.url))], {
    env: environment, stdout: "pipe", stderr: "pipe", serialization: "advanced",
    ipc: value => { notices.push(value as Notice); for (const listener of listeners) listener(); },
  });
  const output = Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text()]);
  const wait = (predicate: (notice: Notice) => boolean): Promise<Notice> => {
    const { promise, resolve, reject } = Promise.withResolvers<Notice>();
    const check = () => {
      const failure = notices.find(item => item.type === "failure"), found = notices.find(predicate);
      if (failure) { listeners.delete(check); reject(new Error(failure.error)); }
      else if (found) { listeners.delete(check); resolve(found); }
    };
    listeners.add(check); check();
    void host.exited.then(async code => { if (listeners.delete(check)) reject(new Error(`Controlled host exited ${code}: ${(await output).join("\n")}`)); });
    return promise;
  };
  let endpoint: WorkerReconnectEndpoint | undefined;
  cleanup.push(async () => {
    if (host.exitCode === null) { host.kill("SIGKILL"); await host.exited; }
    // This PID came from this fixture's authenticated production endpoint.
    if (endpoint) try { process.kill(endpoint.pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  endpoint = (await wait(item => item.type === "created")).endpoint!;
  return { root, host, notices, wait, endpoint, control: (command: Parameters<typeof control>[1]) => control(root, command) };
}

function recoveredHost(root: string) {
  const store = new HostStore(path.join(root, "host"));
  const policy = new NativeResetPolicy({ store, admissions: new ResetAccountAdmissions(store) });
  const contexts: Parameters<NonNullable<WorkerRuntimeOptions["createResetPolicyOwner"]>>[0][] = [];
  const requests: ResetPolicyWireRequest[] = [];
  const lifecycle: Array<{ epoch: string; event: "lost" | "exited" }> = [];
  const options: WorkerRuntimeOptions = { startupTimeoutMs: 5000, shutdownTimeoutMs: 3000,
    createResetPolicyOwner: context => {
      contexts.push(context);
      const owner = new NativeResetPolicyWorkerOwner({ store, policy, context });
      return { handle: request => { requests.push(request); return owner.handle(request); }, beginClose: () => owner.beginClose(),
        workerLost: () => { lifecycle.push({ epoch: context.workerEpoch, event: "lost" }); owner.workerLost(); },
        workerExited: () => { lifecycle.push({ epoch: context.workerEpoch, event: "exited" }); owner.workerExited(); }, drain: () => owner.drain() };
    } };
  cleanup.push(async () => { store.close(); });
  return { store, policy, contexts, requests, lifecycle, options };
}

const admitted = (notice: Notice) => notice.reply?.kind === "admission.execute";
const finished = (notice: Notice) => notice.request?.operation.kind === "checkpoint" && notice.request.operation.event.phase === "finished";
const attemptId = (notice: Notice) => { if (notice.reply?.kind !== "admission.execute") throw new Error("Missing real durable admission"); return notice.reply.permit.attemptId; };

async function detach(f: Awaited<ReturnType<typeof startHost>>) {
  f.host.send({ type: "detach" });
  const result = await f.wait(item => item.type === "detached");
  expect(result.storeClosed).toBe(true);
}

async function retire(client: WorkerClient, policy: NativeResetPolicy, retainsDiagnostic = false) {
  const closing = client.close({ requireAcknowledgement: true });
  if (retainsDiagnostic) await expect(closing).rejects.toBeInstanceOf(Error);
  else await closing;
  await policy.drain();
  expect(() => process.kill(client.pid, 0)).toThrow();
}

test("idle clean restart retains original PID/epoch and permits a new real native pass", async () => {
  const f = await startHost();
  await detach(f);
  const h = recoveredHost(f.root), client = await WorkerClient.recover(h.options, f.endpoint);
  expect(client.pid).toBe(f.endpoint.pid);
  expect(h.contexts).toHaveLength(1);
  expect(h.contexts[0]).toMatchObject({ recovered: true, workerPid: f.endpoint.pid, workerEpoch: f.endpoint.resetPolicy!.workerEpoch,
    snapshot: { id: f.endpoint.resetPolicy!.rootSessionId, cwd: f.endpoint.resetPolicy!.cwd, sessionFile: f.endpoint.resetPolicy!.sessionFile } });
  const sweep = await f.control({ op: "sweep" });
  expect(sweep.policy, JSON.stringify(sweep.resetDiagnostics)).toMatchObject({ state: "settled", applied: 1 });
  const completed = h.requests.find(item => item.operation.kind === "complete")!;
  if (completed.operation.kind !== "complete") throw new Error("Missing authentic completion");
  expect(h.policy.inspectAttempt(completed.operation.permit.attemptId)).toMatchObject({ state: "settled", observed: "reset", live: false });
  const status = await f.control({ op: "status" });
  expect(status.counts, JSON.stringify(status.blocked)).toMatchObject({ consume: 1, escaped: 0 });
  expect(status.counts.blockedPreconnect).toBe(1);
  expect(status.blocked).toEqual(["preconnect https://chatgpt.com"]);
  await retire(client, h.policy);
}, 30000);

test("clean handoff waits for an original native read and journals its terminal callback before store close", async () => {
  const f = await startHost();
  await f.control({ op: "gate", route: "usage" });
  const sweep = f.control({ op: "sweep" });
  await f.control({ op: "wait", route: "usage", count: 1 });
  f.host.send({ type: "detach" });
  await f.wait(item => item.type === "detaching");
  expect(f.notices.some(item => item.type === "detached")).toBe(false);
  expect((await f.control({ op: "status" })).counts.consume).toBe(0);
  await f.control({ op: "release", route: "usage" });
  await sweep;
  await f.wait(item => item.type === "detached");
  const terminal = await f.wait(finished);
  const h = recoveredHost(f.root);
  expect(h.policy.inspectPass(terminal.request!.passId)).toMatchObject({ status: "finished" });
  const client = await WorkerClient.recover(h.options, f.endpoint);
  expect((await f.control({ op: "status" })).counts).toMatchObject({ consume: 0, escaped: 0 });
  await retire(client, h.policy, true);
}, 30000);

test("clean pause fences a durable admission whose original reply has not reached the native guard", async () => {
  const f = await startHost({ holdAdmission: true });
  const sweep = f.control({ op: "sweep" });
  const admission = await f.wait(admitted);
  f.host.send({ type: "detach" });
  await f.wait(item => item.type === "detaching");
  expect(f.notices.some(item => item.type === "detached")).toBe(false);
  f.host.send({ type: "releaseAdmission" });
  await sweep;
  await f.wait(item => item.type === "detached");
  const h = recoveredHost(f.root);
  expect(h.policy.inspectAttempt(attemptId(admission))).toMatchObject({ state: "settled", live: false, attempt: { observation: { consumeBoundary: "refused" } } });
  expect((await f.control({ op: "status" })).counts).toMatchObject({ consume: 0, escaped: 0 });
  const client = await WorkerClient.recover(h.options, f.endpoint);
  await retire(client, h.policy);
}, 30000);

test("hard host loss reconciles an authentic late original consume without replay or invented settlement", async () => {
  const f = await startHost();
  await f.control({ op: "gate", route: "consume" });
  const sweep = f.control({ op: "sweep" });
  await f.control({ op: "wait", route: "consume", count: 1 });
  const admission = await f.wait(admitted), id = attemptId(admission);
  f.host.kill("SIGKILL"); await f.host.exited;
  const h = recoveredHost(f.root);
  expect(h.policy.inspectAttempt(id)).toMatchObject({ state: "unknown", live: false });
  const recovering = WorkerClient.recover(h.options, f.endpoint);
  let ready = false; void recovering.then(() => { ready = true; });
  expect((await f.control({ op: "status" })).counts.consume).toBe(1);
  expect(ready).toBe(false);
  await f.control({ op: "release", route: "consume" });
  const client = await recovering;
  await sweep;
  expect(h.policy.inspectAttempt(id)).toMatchObject({ state: "unknown", observed: "reset", live: false });
  expect(h.requests.filter(item => item.operation.kind === "admit")).toEqual([]);
  expect(h.requests.filter(item => item.operation.kind === "complete")).toHaveLength(1);
  expect((await f.control({ op: "status" })).counts).toMatchObject({ consume: 1, escaped: 0 });
  await retire(client, h.policy);
}, 30000);

test("hard host loss after durable admission but before ACK leaves UNKNOWN and never replays admission", async () => {
  const f = await startHost({ holdAdmission: true });
  const sweep = f.control({ op: "sweep" });
  const admission = await f.wait(admitted), id = attemptId(admission);
  f.host.kill("SIGKILL"); await f.host.exited;
  const h = recoveredHost(f.root), client = await WorkerClient.recover(h.options, f.endpoint);
  await sweep;
  expect(h.policy.inspectAttempt(id)).toMatchObject({ state: "unknown", live: false });
  expect(h.requests.filter(item => item.operation.kind === "admit" || item.operation.kind === "join")).toEqual([]);
  expect((await f.control({ op: "status" })).counts).toMatchObject({ consume: 0, escaped: 0 });
  await retire(client, h.policy, true);
}, 30000);

test("two real original children retain independent epochs and only confirmed disposal reports process exit", async () => {
  const fixtures = await Promise.all([startHost(), startHost()]);
  await Promise.all(fixtures.map(detach));
  const hosts = fixtures.map(fixture => recoveredHost(fixture.root));
  const clients = await Promise.all(fixtures.map((fixture, index) => WorkerClient.recover(hosts[index]!.options, fixture.endpoint)));
  expect(clients[0]!.pid).not.toBe(clients[1]!.pid);
  expect(hosts[0]!.contexts[0]!.workerEpoch).not.toBe(hosts[1]!.contexts[0]!.workerEpoch);
  for (let index = 0; index < fixtures.length; index++) {
    expect((await fixtures[index]!.control({ op: "status" })).sessionId).toBe(hosts[index]!.contexts[0]!.snapshot.id);
    expect(hosts[index]!.lifecycle).toEqual([]);
  }
  await clients[0]!.abandonRecoveryAttempt();
  expect(hosts[0]!.lifecycle.map(item => item.event)).toEqual(["lost"]);
  expect((await fixtures[0]!.control({ op: "status" })).sessionId).toBe(fixtures[0]!.endpoint.resetPolicy!.rootSessionId);
  expect(hosts[1]!.lifecycle).toEqual([]);
  clients[0] = await WorkerClient.recover(hosts[0]!.options, fixtures[0]!.endpoint);
  await Promise.all(clients.map((client, index) => retire(client, hosts[index]!.policy)));
  expect(hosts.map(host => host.lifecycle.filter(item => item.event === "exited").length)).toEqual([1, 1]);
}, 30000);

test("hard loss cancels the original displayed decision and refuses its old Yes without writing or consuming", async () => {
  const f = await startHost({ mode: "unset" });
  const configPath = path.join(f.root, "agent", "config.yml"), before = await readFile(configPath, "utf8");
  await f.control({ op: "armBlocked" });
  f.host.send({ type: "blocked" });
  const displayed = await Promise.race([f.wait(item => item.type === "interaction"),
    f.wait(item => item.type === "promptSettled").then(async result => {
      throw new Error(`No actual reset interaction: ${JSON.stringify({ result, status: await f.control({ op: "status" }) })}`);
    })]);
  const prepared = await f.wait(item => item.request?.operation.kind === "decision.prepare");
  f.host.kill("SIGKILL"); await f.host.exited;
  const h = recoveredHost(f.root);
  expect(h.policy.inspectPass(prepared.request!.passId)).toMatchObject({ status: "closed", record: { closed: { reason: "restarted" } } });
  const client = await WorkerClient.recover(h.options, f.endpoint);
  await f.control({ op: "drain" });
  expect(await client.request<unknown>({ operation: "listInteractions" })).toEqual([]);
  await expect(client.request({ operation: "respondInteraction", args: { id: displayed.interaction!.id, response: { value: "Yes" } } })).rejects.toThrow("no longer pending");
  expect(await readFile(configPath, "utf8")).toBe(before);
  expect((await f.control({ op: "status" })).counts).toMatchObject({ consume: 0, escaped: 0 });
  expect(h.requests.some(request => request.operation.kind === "admit" || request.operation.kind === "decision.prepare")).toBe(false);
  await retire(client, h.policy, true);
}, 30000);

test("failed original prepare retains the live Store and client for a real second handoff attempt", async () => {
  const f = await startHost();
  await f.control({ op: "failPrepare" });
  f.host.send({ type: "detach" });
  expect(await f.wait(item => item.type === "handoffFailed")).toMatchObject({ storeReadable: true });
  expect(f.notices.some(item => item.type === "detached")).toBe(false);
  expect((await f.control({ op: "status" })).sessionId).toBe(f.endpoint.resetPolicy!.rootSessionId);
  await detach(f);
  const h = recoveredHost(f.root), client = await WorkerClient.recover(h.options, f.endpoint);
  await retire(client, h.policy);
}, 30000);

test("failed original owner drain retains its transport and Store until that same owner drains", async () => {
  const f = await startHost({ failDrain: true });
  f.host.send({ type: "detach" });
  expect(await f.wait(item => item.type === "handoffFailed")).toMatchObject({ storeReadable: true });
  expect(f.notices.some(item => item.type === "detached")).toBe(false);
  expect((await f.control({ op: "status" })).sessionId).toBe(f.endpoint.resetPolicy!.rootSessionId);
  await detach(f);
  const h = recoveredHost(f.root), client = await WorkerClient.recover(h.options, f.endpoint);
  await retire(client, h.policy);
}, 30000);
