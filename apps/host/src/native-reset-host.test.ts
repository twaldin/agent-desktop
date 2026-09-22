import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeResetPolicy } from "./native-reset-policy";
import { nativeResetAccountKey } from "./omp/session-usage";
import { ResetAccountAdmissions } from "./session-reset-admission";
import { SessionUsageService } from "./session-usage";
import { HostStore } from "./store";
import { WorkerRuntime, type WorkerSession } from "./omp-workers/runtime";
import { startHost } from "./server";
import { acquireHostLease } from "./lease";

const directories: string[] = [];
const stores: HostStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function store(name: string): Promise<HostStore> {
  const directory = await mkdtemp(path.join(tmpdir(), `${name}-`));
  directories.push(directory);
  const result = new HostStore(directory);
  stores.push(result);
  return result;
}

test("manual and automatic reset paths share one store-bound admission authority", async () => {
  const hostStore = await store("native-reset-host");
  const admissions = new ResetAccountAdmissions(hostStore);
  const policy = new NativeResetPolicy({ store: hostStore, admissions });
  const account = {
    provider: "openai-codex" as const,
    accountId: "account-a",
    email: "a@fixture.invalid",
    credentialId: 7,
    credentialFingerprint: "a".repeat(64),
    authAuthority: "controlled-fixture",
  };
  const accountKey = nativeResetAccountKey(account);
  const held = Promise.withResolvers<{ state: "settled"; outcome: "reset" }>();
  const worker = {
    id: "session-a",
    cwd: directories[0]!,
    sessionFile: path.join(directories[0]!, "session.jsonl"),
    prepareUsageReset: async () => ({
      ticket: "private",
      epoch: "epoch-a",
      accountKey,
      confirmation: {
        account: {
          accountRef: "account-a",
          accountId: "account-a",
          active: true,
        },
        credit: { title: "Saved reset" },
        expiresAt: Date.now() + 60_000,
      },
    }),
    redeemUsageReset: async () => held.promise,
  } as unknown as WorkerSession;
  const usage = new SessionUsageService({
    store: hostStore,
    admissions,
    existing: async () => worker,
    open: async () => worker,
    ordered: async <T>(_id: string, run: () => Promise<T>) => run(),
    assertActive() {},
  });
  expect(usage.admissions).toBe(admissions);
  const prepared = await usage.prepare("manual-prepare", {
    sessionId: worker.id,
    epoch: "epoch-a",
    revision: "revision-a",
    accountRef: "account-a",
  });
  const dispatch = usage.answer("manual-answer", {
    sessionId: worker.id,
    operationId: prepared.operationId,
    confirm: true,
  });
  for (
    let turns = 0;
    turns < 8 && admissions.inspect(accountKey)?.state !== "dispatching";
    turns++
  )
    await null;

  const pass = {
    passId: "pass-a",
    nativeSessionId: "native-a",
    trigger: "blocked" as const,
    source: "blocked" as const,
    startedAtMs: 1,
    provider: "openai-codex",
    modelId: "gpt-5-codex",
  };
  const values = {
    autoRedeem: "yes" as const,
    minBlockedMinutes: 30,
    keepCredits: 1,
    salvageHorizonHours: 24,
  };
  policy.start({
    provenance: {
      hostId: hostStore.host.id,
      sessionId: worker.id,
      sessionFile: worker.sessionFile,
      cwd: worker.cwd,
      workerEpoch: "worker-a",
      nativeSessionId: pass.nativeSessionId,
      passId: pass.passId,
      trigger: pass.trigger,
      source: pass.source,
      startedAtMs: pass.startedAtMs,
      provider: pass.provider,
      modelId: pass.modelId,
      selectionRevision: "selection-a",
      policyRevision: "policy-a",
    },
    policy: values,
  });
  policy.plan(pass.passId, {
    reportRevision: "d".repeat(64),
    plannedAtMs: 2,
    actions: [
      {
        native: {
          reason: "blocked-account",
          target: {
            credentialId: account.credentialId,
            accountId: account.accountId,
          },
          accountKey: account.accountId,
          attemptKey: "blocked:account-a:1",
          label: account.email,
          remainingMs: 3_600_000,
          blockedWindows: ["weekly"],
          active: true,
        },
        account,
      },
    ],
  });
  expect(
    policy.admit(pass.passId, 0, {
      current: {
        workerEpoch: "worker-a",
        nativeSessionId: pass.nativeSessionId,
        selectionRevision: "selection-a",
        policyRevision: "policy-a",
      },
      account,
      credit: {
        id: "credit-a",
        status: "available",
        fingerprint: "c".repeat(64),
      },
    }),
  ).toEqual({ kind: "hold", reason: "manual-collision" });
  held.resolve({ state: "settled", outcome: "reset" });
  await dispatch;
});

test("an injected admission authority rejects a foreign HostStore", async () => {
  const first = await store("native-reset-first"),
    second = await store("native-reset-second");
  const admissions = new ResetAccountAdmissions(first);
  expect(
    () =>
      new SessionUsageService({
        store: second,
        admissions,
        existing: async () => undefined,
        open: async () => {
          throw new Error("unused");
        },
        ordered: async <T>(_id: string, run: () => Promise<T>) => run(),
        assertActive() {},
      }),
  ).toThrow("different host store");
});

test("startHost supplies reset ownership to an actual session worker and drains it before closing its Store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-reset-server-"));
  directories.push(root);
  const dataDirectory = path.join(root, "data"),
    agentDirectory = path.join(root, "agent"),
    cwd = path.join(root, "project");
  await Promise.all(
    [dataDirectory, agentDirectory, cwd].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const log = path.join(root, "worker.jsonl"),
    workerPath = path.join(root, "worker.ts");
  await writeFile(
    workerPath,
    `import {appendFileSync} from "node:fs";\nimport {WORKER_PROTOCOL_VERSION} from ${JSON.stringify(new URL("./omp-workers/protocol.ts", import.meta.url).href)};\nconst log=${JSON.stringify(log)};let binding;let disposeId;const record=(event,value)=>appendFileSync(log,JSON.stringify({event,value})+"\\n");\nprocess.on("message",message=>{void (async()=>{if(message.type==="resetPolicyResponse"){record("reset-response",message.response);return;}if(message.type==="disposeAck"&&message.id===disposeId){record("dispose-ack");process.exit(0);}if(message.type!=="request")return;if(message.operation==="init"){const init=message.args;if(init.mode==="create"){const cwd=init.options.cwd;binding={workerEpoch:init.resetPolicy.workerEpoch,rootSessionId:"reset-policy-root"};process.send({type:"response",id:message.id,ok:true,snapshot:{revision:1,id:"reset-policy-root",sessionFile:cwd+"/session.jsonl",cwd,model:null,isStreaming:false,hasPostPromptWork:false,createdAt:1,activity:{goal:{availability:"unsupported",reason:"fixture"},agents:{availability:"unsupported",reason:"fixture"},jobs:{availability:"unsupported",reason:"fixture"},sources:{availability:"unsupported",reason:"fixture"}}}});setTimeout(()=>{record("reset-sent");process.send({type:"resetPolicyRequest",binding,requestId:1,nativeSessionId:"native-root",passId:"pass-root",operation:{kind:"checkpoint",event:{phase:"started",pass:{passId:"pass-root",nativeSessionId:"native-root",trigger:"blocked",source:"blocked",startedAtMs:1,provider:"openai-codex",modelId:"gpt-5-codex",policy:{autoRedeem:"no",minBlockedMinutes:30,keepCredits:1,salvageHorizonHours:24}}}},evidence:{kind:"source",selectionRevision:"e".repeat(64),policyRevision:"f".repeat(64)}});},25);return;}process.send({type:"response",id:message.id,ok:true});return;}if(message.operation==="listModels"){process.send({type:"response",id:message.id,ok:true,value:[]});return;}if(message.operation==="dispose"){disposeId=message.id;process.send({type:"response",id:message.id,ok:true});return;}process.send({type:"response",id:message.id,ok:true,value:[]});})().catch(error=>{record("error",String(error));process.exit(70);});});process.send({type:"ready",version:WORKER_PROTOCOL_VERSION});\n`,
  );
  const host = await startHost({
    dataDirectory,
    agentDirectory,
    discoveryDirectory: cwd,
    workerPath,
    tailscale: false,
    port: 0,
  });
  const created = await host.dispatch({
    id: "create",
    command: { type: "session.create", projectId: null, cwd },
  });
  expect(created).toMatchObject({
    ok: true,
    value: { id: "reset-policy-root" },
  });
  for (let turns = 0; turns < 50; turns++) {
    if (
      await readFile(log, "utf8").then(
        (value) => value.includes("reset-response"),
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await host.stop();
  expect(() => host.store.listSessions()).toThrow();
  const events = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; value?: unknown });
  expect(events).toContainEqual({
    event: "reset-response",
    value: { ok: true, result: { kind: "checkpointed" } },
  });
  expect(events.map((event) => event.event)).toContain("dispose-ack");
});

test("startup failure preserves its listener error and releases the reset-policy Store for a clean retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-reset-startup-"));
  directories.push(root);
  const first = {
    dataDirectory: path.join(root, "first-data"),
    agentDirectory: path.join(root, "first-agent"),
    discoveryDirectory: path.join(root, "first-project"),
  };
  const second = {
    dataDirectory: path.join(root, "second-data"),
    agentDirectory: path.join(root, "second-agent"),
    discoveryDirectory: path.join(root, "second-project"),
  };
  await Promise.all(
    [...Object.values(first), ...Object.values(second)].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const owner = await startHost({ ...first, tailscale: false, port: 0 });
  const port = Number(new URL(owner.connection.origin).port);
  const originalDispose = WorkerRuntime.prototype.dispose;
  let injected = false;
  WorkerRuntime.prototype.dispose = function (options) {
    if (!injected) {
      injected = true;
      return originalDispose.call(this, options).then(() => {
        throw new Error("controlled startup worker cleanup failure");
      });
    }
    return originalDispose.call(this, options);
  };
  let retry: Awaited<ReturnType<typeof startHost>> | undefined;
  let failure: unknown;
  try {
    let startupError: unknown;
    try {
      await startHost({ ...second, tailscale: false, port });
    } catch (error) {
      startupError = error;
    }
    expect(startupError).toBeInstanceOf(AggregateError);
    const aggregate = startupError as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(String(aggregate.errors[0])).toMatch(/address|listen|use/i);
    expect(aggregate.errors.some(error => error instanceof AggregateError
      && error.errors.some(nested => String(nested).includes("controlled startup worker cleanup failure")))).toBe(true);
    retry = await startHost({ ...second, tailscale: false, port: 0 });
  } catch (error) {
    failure = error;
  } finally {
    WorkerRuntime.prototype.dispose = originalDispose;
    const cleanup = await Promise.allSettled([
      retry?.stop({ finalExit: true }),
      owner.stop({ finalExit: true }),
    ]);
    const cleanupErrors = cleanup.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failure && cleanupErrors.length)
      throw new AggregateError([failure, ...cleanupErrors], "Startup failure fixture assertions and cleanup failed.", { cause: failure });
    if (failure) throw failure;
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Startup failure fixture cleanup failed.");
  }
}, 20_000);

test("failed preserved shutdown keeps its Store and lease until an explicit retry drains a late callback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-reset-retry-"));
  directories.push(root);
  const dataDirectory = path.join(root, "data"),
    agentDirectory = path.join(root, "agent"),
    cwd = path.join(root, "project");
  await Promise.all(
    [dataDirectory, agentDirectory, cwd].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const log = path.join(root, "worker.jsonl"),
    workerPath = path.join(root, "worker.ts"),
    releaseStarted = path.join(root, "release-started"),
    releaseFinished = path.join(root, "release-finished");
  await writeFile(
    workerPath,
    `import {appendFileSync,existsSync} from "node:fs";
import {WORKER_PROTOCOL_VERSION} from ${JSON.stringify(new URL("./omp-workers/protocol.ts", import.meta.url).href)};
const log=${JSON.stringify(log)},releaseStarted=${JSON.stringify(releaseStarted)},releaseFinished=${JSON.stringify(releaseFinished)};let binding;let disposeId;let resetResponses=0;
const pass={passId:"pass-root",nativeSessionId:"native-root",trigger:"blocked",source:"blocked",startedAtMs:1,provider:"openai-codex",modelId:"gpt-5-codex",policy:{autoRedeem:"no",minBlockedMinutes:30,keepCredits:1,salvageHorizonHours:24}};
const record=(event,value)=>appendFileSync(log,JSON.stringify({event,value})+"\\n");
const sendReset=(requestId,event,evidence)=>process.send({type:"resetPolicyRequest",binding,requestId,nativeSessionId:pass.nativeSessionId,passId:pass.passId,operation:{kind:"checkpoint",event},...(evidence?{evidence}:{})});
process.on("message",message=>{void (async()=>{
  if(message.type==="resetPolicyResponse"){
    record("reset-response",message.response);
    if(++resetResponses===1){const gate=setInterval(()=>{if(!existsSync(releaseFinished))return;clearInterval(gate);record("late-finished-sent");sendReset(2,{phase:"finished",pass,settlement:{state:"held",applied:0,attemptIds:[],refresh:"not-needed"}});},5);}
    return;
  }
  if(message.type==="disposeAck"&&message.id===disposeId){record("dispose-ack");process.exit(0);}
  if(message.type!=="request")return;
  if(message.operation==="init"){
    const init=message.args;
    if(init.mode==="create"){
      const cwd=init.options.cwd;binding={workerEpoch:init.resetPolicy.workerEpoch,rootSessionId:"reset-policy-retry"};
      process.send({type:"response",id:message.id,ok:true,snapshot:{revision:1,id:"reset-policy-retry",sessionFile:cwd+"/session.jsonl",cwd,model:null,isStreaming:false,hasPostPromptWork:false,createdAt:1,activity:{goal:{availability:"unsupported",reason:"fixture"},agents:{availability:"unsupported",reason:"fixture"},jobs:{availability:"unsupported",reason:"fixture"},sources:{availability:"unsupported",reason:"fixture"}}}});
      const gate=setInterval(()=>{if(!existsSync(releaseStarted))return;clearInterval(gate);sendReset(1,{phase:"started",pass},{kind:"source",selectionRevision:"e".repeat(64),policyRevision:"f".repeat(64)});},5);return;
    }
    process.send({type:"response",id:message.id,ok:true});return;
  }
  if(message.operation==="listModels"){process.send({type:"response",id:message.id,ok:true,value:[]});return;}
  if(message.operation==="dispose"){disposeId=message.id;process.send({type:"response",id:message.id,ok:true});return;}
  process.send({type:"response",id:message.id,ok:true,value:[]});
})().catch(error=>{record("error",String(error));process.exit(70);});});
process.send({type:"ready",version:WORKER_PROTOCOL_VERSION});
`,
  );
  const host = await startHost({
    dataDirectory,
    agentDirectory,
    discoveryDirectory: cwd,
    workerPath,
    tailscale: false,
    port: 0,
  });
  const created = await host.dispatch({
    id: "create",
    command: { type: "session.create", projectId: null, cwd },
  });
  expect(created).toMatchObject({
    ok: true,
    value: { id: "reset-policy-retry" },
  });
  // Session creation attaches the reset owner; elapsed time is not that acknowledgement.
  await writeFile(releaseStarted, "release\n");
  for (let turns = 0; turns < 50; turns++) {
    if (
      await readFile(log, "utf8").then(
        (value) => value.includes("reset-response"),
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const originalDispose = WorkerRuntime.prototype.dispose;
  let attempts = 0;
  WorkerRuntime.prototype.dispose = function (options) {
    if (++attempts === 1)
      return Promise.reject(new Error("controlled preserve prepare failure"));
    return originalDispose.call(this, options);
  };
  try {
    const initialResponses = (await readFile(log, "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as { event: string; value?: unknown })
      .filter(event => event.event === "reset-response");
    expect(initialResponses.map(event => event.value)).toEqual([
      { ok: true, result: { kind: "checkpointed" } },
    ]);
    const first = host.stop(),
      shared = host.stop();
    const failures = await Promise.allSettled([first, shared]);
    expect(attempts).toBe(1);
    expect(failures.every(result => result.status === "rejected")).toBe(true);
    const [failure, sharedFailure] = failures.map(result => result.status === "rejected" ? result.reason : undefined);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(sharedFailure)).toBe(String(failure));
    expect(
      (failure as AggregateError).errors.map((error) => String(error)),
    ).toContain("Error: controlled preserve prepare failure");
    expect(host.store.listSessions().map((session) => session.id)).toContain(
      "reset-policy-retry",
    );
    await expect(
      startHost({
        dataDirectory,
        agentDirectory,
        discoveryDirectory: cwd,
        workerPath,
        tailscale: false,
        port: 0,
      }),
    ).rejects.toThrow(/already|owns|lease|lock/i);
    await writeFile(releaseFinished, "release\n");
    for (let turns = 0; turns < 50; turns++) {
      if (
        await readFile(log, "utf8").then(
          (value) =>
            value.includes("late-finished-sent") &&
            value.match(/reset-response/g)?.length === 2,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const beforeRetry = await readFile(log, "utf8");
    expect(beforeRetry).toContain("late-finished-sent");
    const responses = beforeRetry.trim().split("\n").map(line => JSON.parse(line) as { event: string; value?: unknown })
      .filter(event => event.event === "reset-response");
    expect(responses).toHaveLength(2);
    expect(responses[1]?.value).toEqual({ ok: true, result: { kind: "checkpointed" } });
    await host.stop();
    expect(() => host.store.listSessions()).toThrow();
    expect((await readFile(log, "utf8")).includes("dispose-ack")).toBe(true);
  } finally {
    WorkerRuntime.prototype.dispose = originalDispose;
    await host.stop().catch(() => {});
  }
}, 20_000);

test("final exit joins an in-flight failed handoff, drains independent cleanup, then releases local ownership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-reset-final-exit-"));
  directories.push(root);
  const dataDirectory = path.join(root, "data"),
    agentDirectory = path.join(root, "agent"),
    cwd = path.join(root, "project"),
    workerPath = path.join(root, "worker.ts");
  await Promise.all([dataDirectory, agentDirectory, cwd].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(workerPath, `import {WORKER_PROTOCOL_VERSION} from ${JSON.stringify(new URL("./omp-workers/protocol.ts", import.meta.url).href)};
let disposeId;
process.on("message",message=>{
  if(message.type==="disposeAck"&&message.id===disposeId){process.exit(0);return;}
  if(message.type!=="request")return;
  if(message.operation==="init"){process.send({type:"response",id:message.id,ok:true});return;}
  if(message.operation==="listModels"){process.send({type:"response",id:message.id,ok:true,value:[]});return;}
  if(message.operation==="dispose"){disposeId=message.id;process.send({type:"response",id:message.id,ok:true});return;}
  process.send({type:"response",id:message.id,ok:true,value:[]});
});
process.send({type:"ready",version:WORKER_PROTOCOL_VERSION});
`);
  const host = await startHost({ dataDirectory, agentDirectory, discoveryDirectory: cwd, workerPath, tailscale: false, port: 0 });
  const originalDispose = WorkerRuntime.prototype.dispose,
    originalDrain = NativeResetPolicy.prototype.drain,
    disposeEntered = Promise.withResolvers<void>(),
    releaseDispose = Promise.withResolvers<void>(),
    drainEntered = Promise.withResolvers<void>(),
    releaseDrain = Promise.withResolvers<void>();
  const disposeFailure = new Error("controlled final-exit handoff failure"),
    drainFailure = new Error("controlled independent reset drain failure");
  WorkerRuntime.prototype.dispose = async function (options) {
    disposeEntered.resolve();
    await releaseDispose.promise;
    await originalDispose.call(this, options);
    throw disposeFailure;
  };
  NativeResetPolicy.prototype.drain = async function () {
    drainEntered.resolve();
    await releaseDrain.promise;
    await originalDrain.call(this);
    throw drainFailure;
  };
  try {
    const ordinary = host.stop();
    await disposeEntered.promise;
    const final = host.stop({ finalExit: true });
    expect(final).toBe(ordinary);
    expect(host.store.listSessions()).toEqual([]);
    expect(() => acquireHostLease(dataDirectory)).toThrow(/already owns/i);

    releaseDispose.resolve();
    const phase = await Promise.race([
      drainEntered.promise.then(() => "draining" as const),
      ordinary.then(() => "settled" as const, () => "settled" as const),
    ]);
    expect(phase).toBe("draining");
    expect(host.store.listSessions()).toEqual([]);
    expect(() => acquireHostLease(dataDirectory)).toThrow(/already owns/i);

    releaseDrain.resolve();
    const outcomes = await Promise.allSettled([ordinary, final]);
    expect(outcomes.every(outcome => outcome.status === "rejected")).toBe(true);
    const [failure, sharedFailure] = outcomes.map(outcome => outcome.status === "rejected" ? outcome.reason : undefined);
    expect(sharedFailure).toBe(failure);
    const messages: string[] = [];
    const collect = (error: unknown): void => {
      messages.push(String(error));
      if (error instanceof AggregateError) for (const nested of error.errors) collect(nested);
    };
    collect(failure);
    expect(messages).toContain(`Error: ${disposeFailure.message}`);
    expect(messages).toContain(`Error: ${drainFailure.message}`);
    expect(() => host.store.listSessions()).toThrow();
    const released = acquireHostLease(dataDirectory);
    expect(released.acquired).toBe(true);
    released.release();
  } finally {
    releaseDispose.resolve(); releaseDrain.resolve();
    WorkerRuntime.prototype.dispose = originalDispose;
    NativeResetPolicy.prototype.drain = originalDrain;
    await host.stop({ finalExit: true }).catch(() => {});
  }
}, 20_000);
