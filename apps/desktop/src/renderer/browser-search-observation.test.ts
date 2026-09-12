import { expect, test } from "bun:test";
import type { BrowserFrameTarget, BrowserObservationBridge, BrowserObservationOwner, BrowserTargetObservation } from "@agent-desktop/shared";
import { readBrowserMetadataLimited } from "./browser-metadata-admission";
import { readBrowserSearchObservations, type BrowserSearchObservationTarget } from "./browser-search-observation";

const session: BrowserObservationOwner = { kind: "session", sessionId: "session" };
const draft: BrowserObservationOwner = { kind: "draft", ownerId: "draft-owner", draftId: "draft", draftRevision: 1 };
const connected = new Set(["host"]);
function selection(key: string, owner: BrowserObservationOwner = session): BrowserSearchObservationTarget {
  return { key, hostId: "host", owner: { ...owner }, target: { workerPid: 42, name: `tab ${key}`, targetId: key } };
}
function observation(input: BrowserSearchObservationTarget, presence: "present" | "absent" = "present"): BrowserTargetObservation {
  return { protocolVersion: 1, hostId: input.hostId, owner: { ...input.owner }, ...input.target,
    ownerId: input.owner.kind === "session" ? input.owner.sessionId : input.owner.ownerId, kindTag: "headless", presence };
}
function changeOwner(owner: BrowserObservationOwner) {
  if (owner.kind === "session") owner.sessionId = "replacement";
  else { owner.ownerId = "replacement"; owner.draftId = "replacement"; owner.draftRevision = 2; }
}

/** Gates model already-sent IPC: abort never resolves them or releases their slots. */
function controlledBridge() {
  const calls: { owner: BrowserObservationOwner; target: BrowserFrameTarget; hostId: string;
    value: BrowserTargetObservation; gate: ReturnType<typeof Promise.withResolvers<BrowserTargetObservation>> }[] = [];
  const listeners = new Map<number, (() => void)[]>();
  let active = 0, peak = 0, released = false;
  const bridge: BrowserObservationBridge = {
    async inspect(owner, target, hostId) {
      const gate = Promise.withResolvers<BrowserTargetObservation>();
      const value = observation({ key: target.targetId, hostId, owner, target });
      calls.push({ owner, target, hostId, value, gate });
      active++; peak = Math.max(peak, active);
      for (const [count, callbacks] of listeners) if (calls.length >= count) {
        listeners.delete(count);
        for (const callback of callbacks) callback();
      }
      if (released) gate.resolve(value);
      try { return await gate.promise; }
      finally { active--; }
    },
  };
  return { bridge, calls, get active() { return active; }, get peak() { return peak; },
    entered(count: number) {
      if (calls.length >= count) return Promise.resolve();
      return new Promise<void>(resolve => listeners.set(count, [...listeners.get(count) ?? [], resolve]));
    },
    release(index: number) { const call = calls[index]!; call.gate.resolve(call.value); },
    releaseAll() {
      released = true;
      for (const call of calls) call.gate.resolve(call.value);
    },
  };
}

test("search accepts exact session and draft observations, including explicit absence and cmux presence", async () => {
  for (const owner of [session, draft]) {
    const inputs = [selection("present", owner), selection("absent", owner), selection("cmux", owner)];
    const seen: BrowserSearchObservationTarget[] = [];
    const bridge: BrowserObservationBridge = { async inspect(receivedOwner, target, hostId) {
      const input = { key: target.targetId, owner: receivedOwner, target, hostId };
      seen.push(input);
      return target.targetId === "cmux" ? { ...observation(input), kindTag: "cmux" }
        : observation(input, target.targetId === "absent" ? "absent" : "present");
    } };
    const result = await readBrowserSearchObservations(inputs, connected, bridge, new AbortController().signal);
    expect(seen).toEqual(inputs);
    expect(result).toEqual(new Map([
      ["present", observation(inputs[0]!)], ["absent", observation(inputs[1]!, "absent")],
      ["cmux", { ...observation(inputs[2]!), kindTag: "cmux" }],
    ]));
  }
});

test("queued search snapshots every caller identity and captures the original inspect method", async () => {
  for (const owner of [session, draft]) {
    const controller = new AbortController();
    const blockers = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    const occupied = blockers.map(gate => readBrowserMetadataLimited(() => gate.promise, controller.signal));
    const input = selection("original", owner);
    const original = structuredClone(input);
    const inputs = [input];
    const calls: BrowserSearchObservationTarget[] = [];
    let replacementCalls = 0;
    const bridge: BrowserObservationBridge = { async inspect(receivedOwner, target, hostId) {
      calls.push({ key: target.targetId, owner: receivedOwner, target, hostId });
      return observation(original);
    } };
    const work = readBrowserSearchObservations(inputs, connected, bridge, controller.signal);
    try {
      expect(calls).toHaveLength(0);
      input.key = "replacement"; input.hostId = "foreign";
      changeOwner(input.owner);
      Object.assign(input.target, { workerPid: 99, name: "replacement", targetId: "replacement" });
      inputs.splice(0, 1, selection("new-selection"));
      bridge.inspect = async () => { replacementCalls++; return observation(input); };
      for (const gate of blockers) gate.resolve();
      expect(await work).toEqual(new Map([[original.key, observation(original)]]));
      expect(calls).toEqual([original]);
      expect(replacementCalls).toBe(0);
    } finally {
      controller.abort();
      for (const gate of blockers) gate.resolve();
      await Promise.allSettled([...occupied, work]);
    }
  }
});

test("bridge argument mutation cannot change the expected identity or mutate caller selection", async () => {
  for (const owner of [session, draft]) for (const returnMutatedIdentity of [false, true]) {
    const input = selection("original", owner), original = structuredClone(input);
    const bridge: BrowserObservationBridge = { async inspect(receivedOwner, target, hostId) {
      changeOwner(receivedOwner);
      Object.assign(target, { workerPid: 99, name: "replacement", targetId: "replacement" });
      return observation(returnMutatedIdentity ? { key: "replacement", hostId, owner: receivedOwner, target } : original);
    } };
    const result = await readBrowserSearchObservations([input], connected, bridge, new AbortController().signal);
    expect(input).toEqual(original);
    expect(result).toEqual(returnMutatedIdentity ? new Map() : new Map([[original.key, observation(original)]]));
  }
});

test("foreign and malformed observations never become entries or absence, while valid siblings survive", async () => {
  for (const owner of [session, draft]) {
    const changedOwners = owner.kind === "session"
      ? [{ ...owner, sessionId: "foreign" }, draft, { ...owner, extra: true }]
      : [{ ...owner, ownerId: "foreign" }, { ...owner, draftId: "foreign" }, { ...owner, draftRevision: 2 }, session];
    const changes: ((value: BrowserTargetObservation) => unknown)[] = [
      () => null, () => [], () => ({}),
      ...changedOwners.map(changed => (value: BrowserTargetObservation) => ({ ...value, owner: changed })),
      value => ({ ...value, protocolVersion: 2 }), value => ({ ...value, hostId: "foreign" }),
      value => ({ ...value, workerPid: 99 }), value => ({ ...value, name: "replacement" }),
      value => ({ ...value, targetId: "replacement" }), value => ({ ...value, ownerId: "foreign" }),
      value => ({ ...value, kindTag: "unknown" }), value => ({ ...value, presence: "unknown" }),
      value => ({ ...value, kindTag: "cmux", presence: "absent" }), value => ({ ...value, extra: true }),
      value => { const { presence: _presence, ...missing } = value; return missing; },
    ];
    const inputs = changes.map((_, index) => selection(String(index), owner));
    const valid = selection("valid", owner);
    inputs.push(valid);
    const calls: string[] = [];
    const bridge: BrowserObservationBridge = { async inspect(receivedOwner, target, hostId) {
      calls.push(target.targetId);
      const value = observation({ key: target.targetId, hostId, owner: receivedOwner, target }, "absent");
      return (target.targetId === "valid" ? value : changes[Number(target.targetId)]!(value)) as BrowserTargetObservation;
    } };
    expect(await readBrowserSearchObservations(inputs, connected, bridge, new AbortController().signal))
      .toEqual(new Map([[valid.key, observation(valid, "absent")]]));
    expect(calls.sort()).toEqual(inputs.map(input => input.target.targetId).sort());
  }
});

test("inspect failures have no entry, retry, metadata, acquisition, or close fallback", async () => {
  for (const owner of [session, draft]) {
    const inputs = [selection("sync-failure", owner), selection("async-failure", owner), selection("valid", owner)];
    const calls: string[] = [], fallbacks: string[] = [];
    const bridge = {
      inspect(receivedOwner: BrowserObservationOwner, target: BrowserFrameTarget, hostId: string) {
        calls.push(target.targetId);
        if (target.targetId === "sync-failure") throw new Error("Controlled unavailable observation");
        if (target.targetId === "async-failure") return Promise.reject(new Error("Controlled stale observation"));
        return Promise.resolve(observation({ key: target.targetId, hostId, owner: receivedOwner, target }));
      },
      metadata() { fallbacks.push("metadata"); }, acquire() { fallbacks.push("acquire"); },
      list() { fallbacks.push("list"); }, close() { fallbacks.push("close"); },
    };
    expect(await readBrowserSearchObservations(inputs, connected, bridge, new AbortController().signal))
      .toEqual(new Map([["valid", observation(inputs[2]!)]]));
    expect(calls).toEqual(inputs.map(input => input.key));
    expect(fallbacks).toEqual([]);
  }
});

test("missing bridge, offline targets, and pre-aborted searches do not dispatch", async () => {
  const online = selection("online"), offline = { ...selection("offline", draft), hostId: "offline" };
  const calls: string[] = [];
  const bridge: BrowserObservationBridge = { async inspect(owner, target, hostId) {
    calls.push(target.targetId);
    return observation({ key: target.targetId, hostId, owner, target });
  } };
  const controller = new AbortController();
  expect(await readBrowserSearchObservations([online], connected, undefined, controller.signal)).toEqual(new Map());
  expect(await readBrowserSearchObservations([offline], connected, bridge, controller.signal)).toEqual(new Map());
  controller.abort();
  expect(await readBrowserSearchObservations([online], connected, bridge, controller.signal)).toEqual(new Map());
  expect(calls).toEqual([]);
  expect(await readBrowserSearchObservations([offline, online], connected, bridge, new AbortController().signal))
    .toEqual(new Map([[online.key, observation(online)]]));
  expect(calls).toEqual([online.key]);
});

test("overlapping searches across bridge replacements share four metadata slots", async () => {
  const first = controlledBridge(), second = controlledBridge();
  const controller = new AbortController();
  const firstInputs = Array.from({ length: 7 }, (_, index) => selection(`first-${index}`));
  const secondInputs = Array.from({ length: 6 }, (_, index) => selection(`second-${index}`, draft));
  const firstWork = readBrowserSearchObservations(firstInputs, connected, first.bridge, controller.signal);
  const secondWork = readBrowserSearchObservations(secondInputs, connected, second.bridge, controller.signal);
  try {
    expect(first.calls).toHaveLength(4);
    expect(second.calls).toHaveLength(0);
    expect(first.active + second.active).toBe(4);
    for (let index = 0; index < 4; index++) {
      first.release(index);
      await second.entered(index + 1);
      expect(first.active + second.active).toBe(4);
      expect(first.calls).toHaveLength(4);
    }
    // A second-round settlement admits a queued first-round target, not a fifth read.
    second.release(0);
    await first.entered(5);
    expect(first.active + second.active).toBe(4);
    first.releaseAll(); second.releaseAll();
    const results = await Promise.all([firstWork, secondWork]);
    expect(results).toEqual([new Map(firstInputs.map(input => [input.key, observation(input)])),
      new Map(secondInputs.map(input => [input.key, observation(input)]))]);
    expect(first.calls).toHaveLength(firstInputs.length);
    expect(second.calls).toHaveLength(secondInputs.length);
    expect(Math.max(first.peak, second.peak)).toBeLessThanOrEqual(4);
  } finally {
    controller.abort(); first.releaseAll(); second.releaseAll();
    await Promise.allSettled([firstWork, secondWork]);
  }
});

test("aborted sent reads retain all slots until settlement; aborted queued reads never dispatch", async () => {
  const old = controlledBridge(), queued = controlledBridge(), fresh = controlledBridge();
  const oldController = new AbortController(), queuedController = new AbortController(), freshController = new AbortController();
  const oldWork = readBrowserSearchObservations(Array.from({ length: 6 }, (_, index) => selection(`old-${index}`)),
    connected, old.bridge, oldController.signal);
  const queuedWork = readBrowserSearchObservations([selection("queued", draft)], connected, queued.bridge, queuedController.signal);
  const freshInput = selection("fresh", draft);
  const freshWork = readBrowserSearchObservations([freshInput], connected, fresh.bridge, freshController.signal);
  try {
    expect(old.calls).toHaveLength(4);
    queuedController.abort(); oldController.abort();
    expect(await queuedWork).toEqual(new Map());
    expect(queued.calls).toHaveLength(0);
    expect(old.active).toBe(4);
    expect(fresh.calls).toHaveLength(0);
    old.release(0);
    await fresh.entered(1);
    expect(old.active + fresh.active).toBe(4);
    expect(queued.calls).toHaveLength(0);
    fresh.releaseAll(); old.releaseAll();
    expect(await oldWork).toEqual(new Map());
    expect(old.calls).toHaveLength(4);
    expect(await freshWork).toEqual(new Map([[freshInput.key, observation(freshInput)]]));
  } finally {
    oldController.abort(); queuedController.abort(); freshController.abort();
    old.releaseAll(); queued.releaseAll(); fresh.releaseAll();
    await Promise.allSettled([oldWork, queuedWork, freshWork]);
  }
});
