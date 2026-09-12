import { expect, test } from "bun:test";
import type { BrowserFrameTarget } from "@agent-desktop/shared";
import { WorkerBrowserObservations, requestWorkerBrowserObservation } from "./observation";

const target: BrowserFrameTarget = { workerPid: 731, name: "desktop-one", targetId: "target-one" };
const ownerId = "owner-one";
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const nativeResult = (selected = target, extra: Record<string, unknown> = {}) => ({
  ownerSessionId: ownerId, name: selected.name, targetId: selected.targetId,
  kindTag: "headless" as const, presence: "present" as const, ...extra,
});
const workerResult = (extra: Record<string, unknown> = {}) => ({ ...target, ownerId, kindTag: "headless" as const, presence: "present" as const, ...extra });

function fixture() {
  let owner = { id: ownerId };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<unknown>();
  const calls: { id: string; selected: { name: string; targetId: string } }[] = [];
  const api = { inspectTabForOwner: async (id: string, selected: { name: string; targetId: string }) => {
    calls.push({ id, selected }); entered.resolve(); return release.promise;
  } };
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, async () => api);
  return { observations, calls, api, entered, release,
    replace() { owner = { id: owner.id }; }, mutate() { owner.id = "owner-two"; },
  };
}

test("child captures its target before import and isolates the native argument and projected result", async () => {
  const owner = { id: ownerId }, imported = Promise.withResolvers<void>();
  const calls: unknown[] = [];
  const receipt = nativeResult(target, { privateEndpoint: "omit" });
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, async () => {
    await imported.promise;
    return { inspectTabForOwner: async (id, selected) => {
      calls.push({ id, selected: { ...selected } });
      selected.name = "native-mutation"; selected.targetId = "native-mutation";
      return receipt;
    } };
  });
  const input = { ...target }, reading = observations.inspect(input);
  input.name = "caller-mutation"; input.targetId = "caller-mutation"; input.workerPid++;
  imported.resolve();
  const result = await reading;
  expect(calls).toEqual([{ id: ownerId, selected: { name: target.name, targetId: target.targetId } }]);
  expect(result).toEqual(workerResult());
  receipt.name = "late-native-mutation";
  expect(result).toEqual(workerResult());
  await observations.dispose();
});

test("child accepts explicit presence for each supported kind and explicit absence except cmux", async () => {
  const owner = { id: ownerId };
  for (const kindTag of ["headless", "spawned", "connected", "relay", "cmux"]) {
    for (const presence of ["present", "absent"]) {
      const observations = new WorkerBrowserObservations(target.workerPid, () => owner, async () => ({
        inspectTabForOwner: async () => nativeResult(target, { kindTag, presence }),
      }));
      const result = await outcome(observations.inspect(target));
      if (kindTag === "cmux" && presence === "absent") expect(result.error).toBeInstanceOf(Error);
      else expect(result.value).toEqual(workerResult({ kindTag, presence }));
      await observations.dispose();
    }
  }
});

test("missing native support and malformed or foreign native replies reject without manufacturing absence", async () => {
  const owner = { id: ownerId };
  const unsupported = new WorkerBrowserObservations(target.workerPid, () => owner, async () => ({}));
  expect((await outcome(unsupported.inspect(target))).error).toBeInstanceOf(Error);
  await unsupported.dispose();
  const invalid = [undefined, null, [], {}, nativeResult(target, { ownerSessionId: "foreign" }),
    nativeResult(target, { name: "foreign" }), nativeResult(target, { targetId: "foreign" }),
    nativeResult(target, { presence: undefined }), nativeResult(target, { presence: false }),
    nativeResult(target, { presence: "missing" }), nativeResult(target, { kindTag: "unknown" }),
    nativeResult(target, { kindTag: undefined }), nativeResult(target, { kindTag: "cmux", presence: "absent" })];
  for (const reply of invalid) {
    let calls = 0;
    const observations = new WorkerBrowserObservations(target.workerPid, () => owner, async () => ({
      inspectTabForOwner: async () => { calls++; return reply; },
    }));
    const result = await outcome(observations.inspect(target));
    expect(result.error).toBeInstanceOf(Error); expect(result.value).toBeUndefined(); expect(calls).toBe(1);
    await observations.dispose();
  }
});

test("invalid worker, target, and owner fail before importing native code", async () => {
  let loads = 0, owner = { id: ownerId };
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, async () => { loads++; return {}; });
  for (const input of [null, {}, { ...target, workerPid: 1 }, { ...target, workerPid: NaN },
    { ...target, name: "" }, { ...target, targetId: "\0" }]) {
    expect((await outcome(observations.inspect(input as BrowserFrameTarget))).error).toBeInstanceOf(Error);
  }
  for (const id of ["", "\0", "x".repeat(201)]) {
    owner = { id }; expect((await outcome(observations.inspect(target))).error).toBeInstanceOf(Error);
  }
  await observations.dispose(); expect(loads).toBe(0);
});

for (const transition of ["replace", "mutate"] as const) {
  test(`owner ${transition} during import prevents native dispatch even when the original identity was valid`, async () => {
    let owner = { id: ownerId };
    const imported = Promise.withResolvers<{}>(), loading = Promise.withResolvers<void>();
    let calls = 0;
    const observations = new WorkerBrowserObservations(target.workerPid, () => owner, () => { loading.resolve(); return imported.promise; });
    const reading = outcome(observations.inspect(target)); await loading.promise;
    if (transition === "replace") owner = { id: ownerId }; else owner.id = "owner-two";
    imported.resolve({ inspectTabForOwner: async () => { calls++; return nativeResult(); } });
    expect((await reading).error).toBeInstanceOf(Error);
    await observations.dispose(); expect(calls).toBe(0);
  });

  test(`owner ${transition} during the native read rejects its otherwise valid late result`, async () => {
    const h = fixture(), reading = outcome(h.observations.inspect(target)); await h.entered.promise;
    h[transition](); h.release.resolve(nativeResult());
    expect((await reading).error).toBeInstanceOf(Error);
    await h.observations.dispose(); expect(h.calls).toHaveLength(1);
  });
}

test("eight pending distinct targets fill admission, duplicates reject, and settlement frees the slot", async () => {
  const owner = { id: ownerId }, gate = Promise.withResolvers<void>();
  const calls: unknown[] = [];
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, async () => ({
    inspectTabForOwner: async (id, selected) => {
      calls.push({ id, selected }); await gate.promise;
      return nativeResult({ workerPid: target.workerPid, ...selected });
    },
  }));
  const targets = Array.from({ length: 9 }, (_, index) => ({ ...target, name: `tab-${index}`, targetId: `target-${index}` }));
  const pending = targets.slice(0, 8).map(selected => observations.inspect(selected));
  expect((await outcome(observations.inspect({ ...targets[0]! }))).error).toBeInstanceOf(Error);
  expect((await outcome(observations.inspect(targets[8]!))).error).toBeInstanceOf(Error);
  expect(calls).toHaveLength(8);
  gate.resolve(); expect(await Promise.all(pending)).toHaveLength(8);
  await observations.inspect(targets[0]!); await observations.inspect(targets[8]!);
  expect(calls).toHaveLength(10); await observations.dispose();
});

test("the admission bound also counts imports that have not dispatched", async () => {
  const owner = { id: ownerId }, imported = Promise.withResolvers<{}>(); let loads = 0;
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, () => { loads++; return imported.promise; });
  const pending = Array.from({ length: 8 }, (_, index) => outcome(observations.inspect({ ...target, targetId: `target-${index}` })));
  expect((await outcome(observations.inspect({ ...target, targetId: "target-0" }))).error).toBeInstanceOf(Error);
  expect((await outcome(observations.inspect({ ...target, targetId: "ninth" }))).error).toBeInstanceOf(Error);
  expect(loads).toBe(8);
  const closing = observations.dispose(); imported.resolve({});
  expect((await Promise.all(pending)).every(result => result.error instanceof Error)).toBe(true);
  await closing;
});

test("independent observation owners do not share a pending target or its reply", async () => {
  const first = fixture(), second = fixture();
  const a = first.observations.inspect(target), b = second.observations.inspect(target);
  await Promise.all([first.entered.promise, second.entered.promise]);
  first.release.resolve(nativeResult(target, { presence: "absent" })); second.release.resolve(nativeResult());
  expect(await a).toEqual(workerResult({ presence: "absent" })); expect(await b).toEqual(workerResult());
  await first.observations.dispose(); await second.observations.dispose();
});

test("reentrant loader retirement retains the held import and suppresses native dispatch", async () => {
  const owner = { id: ownerId }, imported = Promise.withResolvers<{}>();
  let closing: Promise<void> | undefined, done = false, calls = 0;
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, () => {
    closing = observations.dispose().then(() => { done = true; }); return imported.promise;
  });
  const reading = outcome(observations.inspect(target)); await tick();
  expect(done).toBe(false);
  expect((await outcome(observations.inspect(target))).error).toBeInstanceOf(Error);
  imported.resolve({ inspectTabForOwner: async () => { calls++; return nativeResult(); } });
  expect((await reading).error).toBeInstanceOf(Error); await closing;
  expect(done).toBe(true); expect(calls).toBe(0); await observations.dispose();
});

test("retirement joins a dispatched read, rejects its successful late result, and itself succeeds", async () => {
  const h = fixture(), reading = outcome(h.observations.inspect(target)); await h.entered.promise;
  let done = false; const closing = h.observations.dispose().then(() => { done = true; });
  await tick(); expect(done).toBe(false);
  expect((await outcome(h.observations.inspect(target))).error).toBeInstanceOf(Error);
  h.release.resolve(nativeResult());
  expect((await reading).error).toBeInstanceOf(Error); await closing;
  expect(done).toBe(true); expect(h.calls).toHaveLength(1); await h.observations.dispose();
});

for (const failure of ["read", "parse"] as const) test(`retirement reports a genuine dispatched ${failure} failure in its drain`, async () => {
  const h = fixture(), reading = outcome(h.observations.inspect(target)); await h.entered.promise;
  const closing = outcome(h.observations.dispose());
  if (failure === "read") h.release.reject(new Error("native inspection failed"));
  else h.release.resolve(nativeResult(target, { ownerSessionId: "foreign" }));
  const result = await reading, drain = await closing;
  expect(result.error).toBeInstanceOf(Error); expect(drain.error).toBeInstanceOf(AggregateError);
  const errors = (drain.error as AggregateError).errors;
  expect(errors).toHaveLength(1); expect(errors[0]).toBeInstanceOf(Error);
  if (failure === "read") expect(errors[0].message).toBe("native inspection failed");
  expect((await outcome(h.observations.dispose())).error).toBeInstanceOf(AggregateError);
  expect(h.calls).toHaveLength(1);
});

test("a failed held import rejects its caller without becoming a dispatched drain failure", async () => {
  const owner = { id: ownerId }, imported = Promise.withResolvers<{}>();
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, () => imported.promise);
  const reading = outcome(observations.inspect(target)), closing = observations.dispose();
  imported.reject(new Error("import failed"));
  expect((await reading).error?.message).toBe("import failed"); await closing;
});

test("retirement drains every dispatched target even after one read fails", async () => {
  const owner = { id: ownerId }, releases = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()];
  const entered = Promise.withResolvers<void>(); let calls = 0;
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, async () => ({
    inspectTabForOwner: async () => {
      const release = releases[calls++]!; if (calls === 2) entered.resolve(); return release.promise;
    },
  }));
  const other = { ...target, targetId: "other" };
  const first = outcome(observations.inspect(target)), second = outcome(observations.inspect(other));
  await entered.promise;
  let done = false; const closing = outcome(observations.dispose()).then(result => { done = true; return result; });
  releases[0]!.reject(new Error("first read failed")); await first; await tick();
  expect(done).toBe(false);
  releases[1]!.resolve(nativeResult(other)); expect((await second).error).toBeInstanceOf(Error);
  const drain = await closing;
  expect(drain.error).toBeInstanceOf(AggregateError);
  expect((drain.error as AggregateError).errors.map((error: Error) => error.message)).toEqual(["first read failed"]);
  expect(calls).toBe(2);
});

test("failed native reads free their target for a fresh inspection", async () => {
  const owner = { id: ownerId }; let calls = 0;
  const observations = new WorkerBrowserObservations(target.workerPid, () => owner, async () => ({
    inspectTabForOwner: async () => { if (++calls === 1) throw new Error("temporary read failure"); return nativeResult(); },
  }));
  expect((await outcome(observations.inspect(target))).error?.message).toBe("temporary read failure");
  expect(await observations.inspect(target)).toEqual(workerResult());
  await observations.dispose(); expect(calls).toBe(2);
});

test("daemon copies caller and wire targets and projects only the validated observation", async () => {
  const gate = Promise.withResolvers<unknown>(); let calls = 0;
  const client = { pid: target.workerPid, request: async (operation: { operation: "inspectBrowserTab"; args: { target: BrowserFrameTarget } }) => {
    calls++; expect(operation).toEqual({ operation: "inspectBrowserTab", args: { target } });
    operation.args.target.name = "wire-mutation"; operation.args.target.targetId = "wire-mutation";
    operation.args.target.workerPid++;
    return gate.promise;
  } };
  const input = { ...target }, reading = requestWorkerBrowserObservation(client, ownerId, input);
  expect(input).toEqual(target); input.name = "caller-mutation"; input.targetId = "caller-mutation"; input.workerPid++;
  const receipt = workerResult({ privateEndpoint: "omit" }); gate.resolve(receipt);
  const result = await reading; expect(result).toEqual(workerResult());
  receipt.name = "late-worker-mutation"; expect(result).toEqual(workerResult()); expect(calls).toBe(1);
});

test("daemon rejects invalid admission without sending a request", async () => {
  let calls = 0; const client = { pid: target.workerPid, request: async () => { calls++; return workerResult(); } };
  for (const input of [{ ...target, workerPid: 1 }, { ...target, name: "" }, { ...target, targetId: "\0" }]) {
    expect((await outcome(requestWorkerBrowserObservation(client, ownerId, input))).error).toBeInstanceOf(Error);
  }
  for (const id of ["", "\0", "x".repeat(201)]) {
    expect((await outcome(requestWorkerBrowserObservation(client, id, target))).error).toBeInstanceOf(Error);
  }
  expect(calls).toBe(0);
});

test("daemon validates reply identities and discriminants without retrying or converting failures to absence", async () => {
  for (const reply of [undefined, null, [], {}, workerResult({ workerPid: 1 }), workerResult({ ownerId: "foreign" }),
    workerResult({ name: "foreign" }), workerResult({ targetId: "foreign" }), workerResult({ kindTag: "unknown" }),
    workerResult({ kindTag: undefined }), workerResult({ presence: undefined }), workerResult({ presence: "missing" }),
    workerResult({ kindTag: "cmux", presence: "absent" })]) {
    let calls = 0;
    const result = await outcome(requestWorkerBrowserObservation({ pid: target.workerPid, request: async () => { calls++; return reply; } }, ownerId, target));
    expect(result.error).toBeInstanceOf(Error); expect(result.value).toBeUndefined(); expect(calls).toBe(1);
  }
  let calls = 0;
  const result = await outcome(requestWorkerBrowserObservation({ pid: target.workerPid, request: async () => {
    calls++; throw new Error("worker disconnected");
  } }, ownerId, target));
  expect(result.error?.message).toBe("worker disconnected"); expect(calls).toBe(1);
  expect(await requestWorkerBrowserObservation({ pid: target.workerPid, request: async () => workerResult({ kindTag: "relay", presence: "absent" }) }, ownerId, target))
    .toEqual(workerResult({ kindTag: "relay", presence: "absent" }));
});
