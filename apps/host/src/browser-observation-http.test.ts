import { expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameTarget } from "@agent-desktop/shared";
import type { DraftBrowserAdmissionRequest } from "./browser-draft-admission";
import { BrowserObservationHttp } from "./browser-observation-http";
import type { WorkerBrowserObservation } from "./omp-browser/observation";

const target: BrowserFrameTarget = { workerPid: 731, name: "main", targetId: "native-one" };
const binding: DraftBrowserAdmissionRequest = { hostId: "host", ownerId: "owner", draftId: "draft", draftRevision: 1 };
type Handle = {
  id: string;
  workerPid: number;
  workerFailure?: { message: string };
  inspectBrowserTab(selected: BrowserFrameTarget): Promise<WorkerBrowserObservation>;
};
const observation = (ownerId = "session", selected = target, extra: Record<string, unknown> = {}): WorkerBrowserObservation =>
  ({ ...selected, ownerId, kindTag: "headless", presence: "present", ...extra }) as WorkerBrowserObservation;
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
const headers = (host = "host") => ({ [BROWSER_METADATA_OWNER_HEADER]: host });
function sessionRequest(selected = target, sessionId = "session") {
  return new Request(`http://fixture/v1/sessions/${encodeURIComponent(sessionId)}/browser-target-observation?` +
    new URLSearchParams({ workerPid: String(selected.workerPid), name: selected.name, targetId: selected.targetId }), { headers: headers() });
}
function draftRequest(owner = binding, selected = target) {
  return new Request(`http://fixture/v1/draft-browser-owners/${encodeURIComponent(owner.ownerId)}/target-observation`, {
    method: "POST", headers: headers(), body: JSON.stringify({ draftId: owner.draftId, draftRevision: owner.draftRevision, target: selected }),
  });
}
async function reply(http: BrowserObservationHttp, request: Request) {
  const response = await http.route(request);
  if (!response) throw new Error("Expected browser observation route");
  return { response, status: response.status, body: await response.json() };
}
function fixture(overrides: Partial<ConstructorParameters<typeof BrowserObservationHttp>[0]> = {}) {
  const reads: { ownerId: string; target: BrowserFrameTarget }[] = [], sessionLookups: string[] = [], draftLookups: DraftBrowserAdmissionRequest[] = [];
  const handle = (id: string): Handle => ({ id, workerPid: target.workerPid, inspectBrowserTab: async selected => {
    reads.push({ ownerId: id, target: { ...selected } }); return observation(id, selected);
  } });
  const state = { sessionExists: true, draftReady: true, session: handle("session") as Handle | undefined, draft: handle("owner") as Handle | undefined };
  const http = new BrowserObservationHttp({ hostId: "host", sessionExists: () => state.sessionExists, draftReady: () => state.draftReady,
    getSessionHandle: async id => { sessionLookups.push(id); return state.session; },
    getDraftHandle: async owner => { draftLookups.push({ ...owner }); return state.draft; }, ...overrides,
  });
  return { http, state, reads, sessionLookups, draftLookups, handle };
}

test("session and draft observations expose exact ownership and only bounded read fields", async () => {
  const f = fixture();
  f.state.session!.inspectBrowserTab = async selected => observation("session", selected, { privateEndpoint: "omit", url: "omit", title: "omit" });
  for (const [request, owner, ownerId] of [
    [sessionRequest(), { kind: "session", sessionId: "session" }, "session"],
    [draftRequest(), { kind: "draft", ownerId: "owner", draftId: "draft", draftRevision: 1 }, "owner"],
  ] as const) {
    const result = await reply(f.http, request);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ protocolVersion: 1, hostId: "host", owner, ...observation(ownerId) });
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.response.headers.get(BROWSER_METADATA_OWNER_HEADER)).toBe("host");
  }
  expect(f.draftLookups.every(owner => JSON.stringify(owner) === JSON.stringify(binding))).toBe(true);
  await f.http.dispose();
});

test("only explicit supported worker presence becomes presence or absence", async () => {
  const f = fixture();
  for (const kindTag of ["headless", "spawned", "connected", "relay", "cmux"]) {
    for (const presence of ["present", "absent"]) {
      f.state.session!.inspectBrowserTab = async () => observation("session", target, { kindTag, presence });
      const result = await reply(f.http, sessionRequest());
      if (kindTag === "cmux" && presence === "absent") {
        expect(result.status).toBe(503); expect(result.body).not.toHaveProperty("presence");
      } else {
        expect(result.status).toBe(200); expect(result.body).toMatchObject({ kindTag, presence });
      }
    }
  }
  await f.http.dispose();
});

test("worker argument mutation cannot rewrite the selected target or the response envelope", async () => {
  const f = fixture();
  f.state.session!.inspectBrowserTab = async selected => {
    expect(selected).toEqual(target);
    selected.workerPid++; selected.name = "worker-mutation"; selected.targetId = "worker-mutation";
    return observation();
  };
  const result = await reply(f.http, sessionRequest());
  expect(result.status).toBe(200); expect(result.body).toMatchObject(target);
  await f.http.dispose();
});

test("foreign or missing host, wrong methods and invalid selectors never access a worker", async () => {
  const f = fixture();
  for (const host of [undefined, "foreign"]) {
    const request = new Request(sessionRequest().url, { headers: host === undefined ? {} : headers(host) });
    expect((await reply(f.http, request)).status).toBe(409);
  }
  expect((await reply(f.http, new Request(sessionRequest().url, { method: "POST", headers: headers() }))).status).toBe(405);
  expect((await reply(f.http, new Request(draftRequest().url, { headers: headers() }))).status).toBe(405);
  for (const suffix of ["", "workerPid=731&name=main", "workerPid=0&name=main&targetId=native-one",
    "workerPid=1.5&name=main&targetId=native-one", "workerPid=NaN&name=main&targetId=native-one",
    "workerPid=731&name=&targetId=native-one", "workerPid=731&name=main&targetId=%00",
    "workerPid=731&name=main&targetId=native-one&workerPid=731", "workerPid=731&name=main&targetId=native-one&extra=1"]) {
    expect((await reply(f.http, new Request("http://fixture/v1/sessions/session/browser-target-observation?" + suffix, { headers: headers() }))).status).toBe(400);
  }
  for (const id of ["%00", "%ZZ", "x".repeat(201)]) {
    const url = sessionRequest().url.replace("/session/", `/${id}/`);
    expect((await reply(f.http, new Request(url, { headers: headers() }))).status).toBe(400);
  }
  expect(f.sessionLookups).toEqual([]); expect(f.draftLookups).toEqual([]); expect(f.reads).toEqual([]);
  expect(await f.http.route(new Request("http://fixture/v1/elsewhere"))).toBeUndefined();
  await f.http.dispose();
});

test("draft body validation rejects unbound or extra input before worker lookup", async () => {
  const f = fixture(), valid = { draftId: "draft", draftRevision: 1, target };
  for (const body of ["{", "null", "[]", JSON.stringify({}), JSON.stringify({ ...valid, draftId: "" }),
    JSON.stringify({ ...valid, draftRevision: 0 }), JSON.stringify({ ...valid, draftRevision: 1.5 }),
    JSON.stringify({ ...valid, target: { ...target, workerPid: 0 } }), JSON.stringify({ ...valid, target: { ...target, extra: true } }),
    JSON.stringify({ ...valid, ownerId: "foreign" }), JSON.stringify({ ...valid, acquire: true })]) {
    const result = await reply(f.http, new Request(draftRequest().url, { method: "POST", headers: headers(), body }));
    expect(result.status).toBe(400); expect(result.body).not.toHaveProperty("presence");
  }
  expect(f.draftLookups).toEqual([]); expect(f.reads).toEqual([]); await f.http.dispose();
});

test("missing owners or workers and stale worker identity stay errors without acquisition", async () => {
  const f = fixture();
  f.state.sessionExists = false; f.state.draftReady = false;
  expect((await reply(f.http, sessionRequest())).status).toBe(409);
  expect((await reply(f.http, draftRequest())).status).toBe(409);
  expect(f.sessionLookups).toEqual([]); expect(f.draftLookups).toEqual([]);
  f.state.sessionExists = true; f.state.draftReady = true;
  for (const state of [undefined, { ...f.handle("session"), workerPid: 732 }, { ...f.handle("session"), id: "foreign" },
    { ...f.handle("session"), workerFailure: { message: "exited" } }]) {
    f.state.session = state;
    const result = await reply(f.http, sessionRequest());
    expect(result.status).toBe(409); expect(result.body).not.toHaveProperty("presence");
  }
  f.state.draft = undefined;
  expect((await reply(f.http, draftRequest())).status).toBe(409);
  expect(f.reads).toEqual([]); await f.http.dispose();
});

test("missing capability and malformed worker replies fail closed and permit a fresh read", async () => {
  const f = fixture();
  const invalid: unknown[] = [undefined, null, [], {}, observation("foreign"), observation("session", target, { workerPid: 732 }),
    observation("session", target, { name: "foreign" }), observation("session", target, { targetId: "foreign" }),
    observation("session", target, { kindTag: "unknown" }), observation("session", target, { kindTag: undefined }),
    observation("session", target, { presence: false }), observation("session", target, { presence: undefined })];
  for (const value of invalid) {
    f.state.session!.inspectBrowserTab = async () => value as WorkerBrowserObservation;
    const result = await reply(f.http, sessionRequest());
    expect(result.status).toBe(503); expect(result.body).not.toHaveProperty("presence");
  }
  f.state.session = { id: "session", workerPid: target.workerPid } as Handle;
  expect((await reply(f.http, sessionRequest())).status).toBe(503);
  f.state.session = f.handle("session");
  expect((await reply(f.http, sessionRequest())).status).toBe(200);
  await f.http.dispose();
});

test("failed worker reads release their slot and never expose native error details", async () => {
  const f = fixture(); let calls = 0;
  f.state.session!.inspectBrowserTab = async () => { if (++calls === 1) throw new Error("private native endpoint"); return observation(); };
  const failed = await reply(f.http, sessionRequest());
  expect(failed.status).toBe(503); expect(JSON.stringify(failed.body)).not.toContain("private native endpoint");
  expect(failed.body).not.toHaveProperty("presence");
  expect((await reply(f.http, sessionRequest())).status).toBe(200); expect(calls).toBe(2);
  await f.http.dispose();
});

test("exact pending reads coalesce; different targets and owner kinds do not; completed reads refresh", async () => {
  const gate = Promise.withResolvers<void>(), f = fixture();
  for (const handle of [f.state.session!, f.state.draft!]) handle.inspectBrowserTab = async selected => {
    f.reads.push({ ownerId: handle.id, target: { ...selected } }); await gate.promise; return observation(handle.id, selected);
  };
  const first = reply(f.http, sessionRequest()), joined = reply(f.http, sessionRequest());
  const otherTarget = reply(f.http, sessionRequest({ ...target, targetId: "native-two" }));
  const draft = reply(f.http, draftRequest()); await tick();
  const active = [...f.reads]; gate.resolve();
  const results = await Promise.all([first, joined, otherTarget, draft]);
  expect(active).toHaveLength(3); expect(results.map(result => result.status)).toEqual([200, 200, 200, 200]);
  expect(results[0]!.body).toEqual(results[1]!.body);
  expect(results[3]!.body.owner).toEqual({ kind: "draft", ownerId: "owner", draftId: "draft", draftRevision: 1 });
  expect((await reply(f.http, sessionRequest())).status).toBe(200); expect(f.reads).toHaveLength(4);
  await f.http.dispose();
});

test("draft revisions and draft IDs cannot join another binding's pending read", async () => {
  const gate = Promise.withResolvers<void>(), f = fixture(); let calls = 0;
  f.state.draft!.inspectBrowserTab = async () => { calls++; await gate.promise; return observation("owner"); };
  const requests = [binding, { ...binding, draftRevision: 2 }, { ...binding, draftId: "other-draft" }];
  const pending = requests.map(owner => reply(f.http, draftRequest(owner))); await tick();
  const active = calls; gate.resolve(); const results = await Promise.all(pending);
  expect(active).toBe(3); expect(results.every(result => result.status === 200)).toBe(true);
  expect(results.map(result => result.body.owner)).toEqual(requests.map(({ hostId: _hostId, ...owner }) => ({ kind: "draft", ...owner })));
  await f.http.dispose();
});

test("eight slots are global across session and draft owners and duplicate reads need no slot", async () => {
  const gate = Promise.withResolvers<void>(), f = fixture();
  for (const handle of [f.state.session!, f.state.draft!]) handle.inspectBrowserTab = async selected => {
    f.reads.push({ ownerId: handle.id, target: { ...selected } }); await gate.promise; return observation(handle.id, selected);
  };
  const pending = Array.from({ length: 8 }, (_, i) => {
    const selected = { ...target, targetId: `native-${i}` };
    return reply(f.http, i % 2 ? draftRequest(binding, selected) : sessionRequest(selected));
  }); await tick();
  const joined = reply(f.http, sessionRequest({ ...target, targetId: "native-0" }));
  const refused = await reply(f.http, draftRequest(binding, { ...target, targetId: "ninth" }));
  const active = f.reads.length; gate.resolve(); const results = await Promise.all([...pending, joined]);
  expect(refused.status).toBe(429); expect(active).toBe(8); expect(results.every(result => result.status === 200)).toBe(true);
  expect((await reply(f.http, sessionRequest())).status).toBe(200); await f.http.dispose();
});

test("admission counts held worker lookups and coalesces before lookup completes", async () => {
  const gate = Promise.withResolvers<Handle | undefined>(); let lookups = 0, reads = 0;
  const handle: Handle = { id: "session", workerPid: target.workerPid, inspectBrowserTab: async selected => { reads++; return observation("session", selected); } };
  const f = fixture({ getSessionHandle: async () => { lookups++; return gate.promise; } });
  const pending = Array.from({ length: 8 }, (_, i) => reply(f.http, sessionRequest({ ...target, targetId: `native-${i}` })));
  const joined = reply(f.http, sessionRequest({ ...target, targetId: "native-0" })); await tick();
  const refused = await reply(f.http, sessionRequest({ ...target, targetId: "ninth" }));
  const waitingLookups = lookups, waitingReads = reads; gate.resolve(handle);
  const results = await Promise.all([...pending, joined]);
  expect(refused.status).toBe(429); expect(waitingLookups).toBe(8); expect(waitingReads).toBe(0);
  expect(results.every(result => result.status === 200)).toBe(true); expect(reads).toBe(8); await f.http.dispose();
});

for (const kind of ["session", "draft"] as const) {
  test(`${kind} owner invalidated during lookup cannot dispatch`, async () => {
    const gate = Promise.withResolvers<Handle | undefined>(), entered = Promise.withResolvers<void>();
    const lookup = async () => { entered.resolve(); return gate.promise; };
    const f = fixture(kind === "session" ? { getSessionHandle: lookup } : { getDraftHandle: lookup });
    const reading = reply(f.http, kind === "session" ? sessionRequest() : draftRequest()); await entered.promise;
    f.state.sessionExists = false; f.state.draftReady = false; gate.resolve(f.state[kind]);
    const result = await reading;
    expect(result.status).toBe(409); expect(result.body).not.toHaveProperty("presence"); expect(f.reads).toEqual([]);
    await f.http.dispose();
  });

  for (const change of ["replace", "id", "pid", "failure", "owner"] as const) {
    test(`${kind} ${change} during worker read suppresses the late valid result`, async () => {
      const gate = Promise.withResolvers<WorkerBrowserObservation>(), entered = Promise.withResolvers<void>(), f = fixture();
      const handle = f.state[kind]!, ownerId = handle.id;
      handle.inspectBrowserTab = async () => { entered.resolve(); return gate.promise; };
      const reading = reply(f.http, kind === "session" ? sessionRequest() : draftRequest()); await entered.promise;
      if (change === "replace") f.state[kind] = f.handle(ownerId);
      else if (change === "id") handle.id = "replacement";
      else if (change === "pid") handle.workerPid++;
      else if (change === "failure") handle.workerFailure = { message: "exited" };
      else { f.state.sessionExists = false; f.state.draftReady = false; }
      gate.resolve(observation(ownerId)); const result = await reading;
      expect(result.status).toBe(409); expect(result.body).not.toHaveProperty("presence"); await f.http.dispose();
    });
  }
}

test("a held final lookup cannot hide original handle mutation or owner invalidation", async () => {
  for (const change of ["id", "pid", "failure", "owner"] as const) {
    const gate = Promise.withResolvers<Handle | undefined>(), entered = Promise.withResolvers<void>(); let inspected = false;
    const handle: Handle = { id: "session", workerPid: target.workerPid, inspectBrowserTab: async () => { inspected = true; return observation(); } };
    const f = fixture({ getSessionHandle: async () => { if (!inspected) return handle; entered.resolve(); return gate.promise; } });
    const reading = reply(f.http, sessionRequest()); await entered.promise;
    if (change === "id") handle.id = "replacement";
    else if (change === "pid") handle.workerPid++;
    else if (change === "failure") handle.workerFailure = { message: "exited" };
    else f.state.sessionExists = false;
    gate.resolve(handle); const result = await reading;
    expect(result.status).toBe(409); expect(result.body).not.toHaveProperty("presence"); await f.http.dispose();
  }
});

test("retirement waits for the actual read and suppresses its successful late response", async () => {
  const gate = Promise.withResolvers<WorkerBrowserObservation>(), entered = Promise.withResolvers<void>(), f = fixture();
  f.state.session!.inspectBrowserTab = async () => { entered.resolve(); return gate.promise; };
  const reading = reply(f.http, sessionRequest()); await entered.promise;
  let done = false; const closing = f.http.dispose().then(() => { done = true; }); await tick();
  const early = done, refused = await reply(f.http, draftRequest()); gate.resolve(observation());
  const result = await reading; await closing;
  expect(early).toBe(false); expect(done).toBe(true); expect(refused.status).toBe(503);
  expect(result.status).toBe(503); expect(result.body).not.toHaveProperty("presence"); await f.http.dispose();
});

test("retirement waits for held lookup and never dispatches after it resolves", async () => {
  const gate = Promise.withResolvers<Handle | undefined>(), entered = Promise.withResolvers<void>();
  const f = fixture({ getSessionHandle: async () => { entered.resolve(); return gate.promise; } });
  const reading = reply(f.http, sessionRequest()); await entered.promise;
  let done = false; const closing = f.http.dispose().then(() => { done = true; }); await tick();
  const early = done; gate.resolve(f.state.session); const result = await reading; await closing;
  expect(early).toBe(false); expect(result.status).toBe(503); expect(f.reads).toEqual([]); expect(done).toBe(true);
});

test("reentrant retirement from lookup still drains its admitted operation", async () => {
  const gate = Promise.withResolvers<Handle | undefined>(); let closing: Promise<void> | undefined, done = false;
  const f = fixture({ getSessionHandle: async () => { closing = f.http.dispose().then(() => { done = true; }); return gate.promise; } });
  const reading = reply(f.http, sessionRequest()); await tick(); const early = done;
  gate.resolve(f.state.session); const result = await reading; await closing;
  expect(early).toBe(false); expect(result.status).toBe(503); expect(done).toBe(true); expect(f.reads).toEqual([]);
});

test("retirement preserves genuine read failure and drains every active read before rejecting", async () => {
  const gates = [Promise.withResolvers<WorkerBrowserObservation>(), Promise.withResolvers<WorkerBrowserObservation>()];
  const entered = Promise.withResolvers<void>(), f = fixture(); let calls = 0;
  f.state.session!.inspectBrowserTab = async () => { const gate = gates[calls++]!; if (calls === 2) entered.resolve(); return gate.promise; };
  const first = reply(f.http, sessionRequest()), second = reply(f.http, sessionRequest({ ...target, targetId: "second" }));
  await entered.promise; let done = false;
  const closing = outcome(f.http.dispose()).then(result => { done = true; return result; });
  const failure = new Error("private native read failed"); gates[0]!.reject(failure);
  const firstResult = await first; await tick(); const early = done;
  gates[1]!.resolve(observation("session", { ...target, targetId: "second" }));
  const secondResult = await second, drain = await closing;
  expect(early).toBe(false); expect(firstResult.status).toBe(503); expect(secondResult.status).toBe(503);
  expect(JSON.stringify(firstResult.body)).not.toContain(failure.message);
  expect(drain.error).toBeInstanceOf(AggregateError); expect((drain.error as AggregateError).errors).toEqual([failure]);
  const repeated = await outcome(f.http.dispose());
  expect(repeated.error).toBeInstanceOf(AggregateError);
  expect(repeated.error!.message).toBe(drain.error!.message);
  expect((repeated.error as AggregateError).errors.map((error: Error) => error.message)).toEqual([failure.message]);
  expect(calls).toBe(2);
});

test("lookup failure during retirement is unavailable without inventing a native drain failure", async () => {
  const gate = Promise.withResolvers<Handle | undefined>(), entered = Promise.withResolvers<void>();
  const f = fixture({ getSessionHandle: async () => { entered.resolve(); return gate.promise; } });
  const reading = reply(f.http, sessionRequest()); await entered.promise; const closing = f.http.dispose();
  gate.reject(new Error("private lookup failure")); const result = await reading; await closing;
  expect(result.status).toBe(503); expect(JSON.stringify(result.body)).not.toContain("private lookup failure"); expect(f.reads).toEqual([]);
});
