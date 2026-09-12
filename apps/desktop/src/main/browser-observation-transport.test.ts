import { afterEach, expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameTarget } from "@agent-desktop/shared";
import type { BrowserObservationOwner, BrowserTargetObservation } from "../../../../packages/shared/src/browser-observation";
import { BrowserObservationHttp } from "../../../host/src/browser-observation-http";
import type { WorkerBrowserObservation } from "../../../host/src/omp-browser/observation";
import { BrowserObservationTransport } from "./browser-observation-transport";
import { HostRequestError } from "./host-transport";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const endpoint = { hostId: "host", origin: "https://fixture.invalid", token: "fixture-main-token" };
const session: BrowserObservationOwner = { kind: "session", sessionId: "session" };
const draft: BrowserObservationOwner = { kind: "draft", ownerId: "draft-owner", draftId: "draft", draftRevision: 1 };
const target: BrowserFrameTarget = { workerPid: 42, name: "original tab", targetId: "target/original?" };
const ownerId = (owner: BrowserObservationOwner) => owner.kind === "session" ? owner.sessionId : owner.ownerId;
function observation(owner = session, input = target, presence: "present" | "absent" = "present"): BrowserTargetObservation {
  return { protocolVersion: 1, hostId: endpoint.hostId, owner: structuredClone(owner), ...input, ownerId: ownerId(owner), kindTag: "headless", presence };
}
function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { [BROWSER_METADATA_OWNER_HEADER]: endpoint.hostId } });
}
function responseFrom(make: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return await make(request);
  }) as typeof fetch;
  return requests;
}

test("session and draft inspect snapshot the original host, owner and target and send only the observation route", async () => {
  for (const owner of [session, draft]) {
    const selectedEndpoint = { ...endpoint };
    const selectedOwner = structuredClone(owner);
    const selectedTarget = { ...target };
    const transport = new BrowserObservationTransport(selectedEndpoint, selectedOwner);
    // Mutating selection before inspect must not retarget the constructed transport.
    selectedEndpoint.hostId = "foreign";
    selectedEndpoint.origin = "https://replacement.invalid";
    selectedEndpoint.token = "replacement-token";
    if (selectedOwner.kind === "session") selectedOwner.sessionId = "replacement";
    else { selectedOwner.ownerId = "replacement"; selectedOwner.draftId = "replacement"; selectedOwner.draftRevision = 2; }
    const gate = Promise.withResolvers<Response>();
    const requests = responseFrom(() => gate.promise);
    const work = transport.inspect(selectedTarget);
    selectedTarget.workerPid = 99;
    selectedTarget.name = "replacement";
    selectedTarget.targetId = "replacement";
    gate.resolve(reply(observation(owner)));
    expect(await work).toEqual(observation(owner));
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const url = new URL(request.url);
    expect(url.origin).toBe(endpoint.origin);
    expect(request.redirect).toBe("error");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-main-token");
    expect(request.headers.get(BROWSER_METADATA_OWNER_HEADER)).toBe("host");
    if (owner.kind === "session") {
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/v1/sessions/session/browser-target-observation");
      expect([...url.searchParams.entries()]).toHaveLength(3);
      expect(Object.fromEntries(url.searchParams)).toEqual({ workerPid: "42", name: target.name, targetId: target.targetId });
      expect(await request.text()).toBe("");
    } else {
      expect(request.method).toBe("POST");
      expect(url.pathname).toBe("/v1/draft-browser-owners/draft-owner/target-observation");
      expect(url.search).toBe("");
      expect(await request.json()).toEqual({ draftId: "draft", draftRevision: 1, target });
    }
  }
});

test("every supported kind has explicit presence; cmux absence and malformed identity never become absence", async () => {
  for (const owner of [session, draft]) {
    const transport = new BrowserObservationTransport(endpoint, owner);
    for (const kindTag of ["headless", "spawned", "connected", "relay", "cmux"] as const) {
      for (const presence of ["present", "absent"] as const) {
        const value = { ...observation(owner), kindTag, presence };
        const requests = responseFrom(() => reply(value));
        if (kindTag === "cmux" && presence === "absent") await expect(transport.inspect(target)).rejects.toThrow();
        else expect(await transport.inspect(target)).toEqual(value);
        expect(requests).toHaveLength(1);
      }
    }
    const base = observation(owner, target, "absent");
    const badOwners = owner.kind === "session"
      ? [{ ...owner, sessionId: "foreign" }, draft, { ...owner, draftId: "extra" }]
      : [{ ...owner, ownerId: "foreign" }, { ...owner, draftId: "foreign" }, { ...owner, draftRevision: 2 }, session, { ...owner, sessionId: "extra" }];
    const invalid: unknown[] = [null, [], {}, ...badOwners.map(changed => ({ ...base, owner: changed })),
      { ...base, protocolVersion: 2 }, { ...base, protocolVersion: "1" }, { ...base, hostId: "foreign" },
      { ...base, workerPid: 43 }, { ...base, workerPid: "42" }, { ...base, name: "replacement" },
      { ...base, targetId: "replacement" }, { ...base, ownerId: "foreign" }, { ...base, kindTag: "unknown" },
      { ...base, presence: "unknown" }, { ...base, presence: false }, { ...base, extra: true },
      { ...base, url: "https://replacement.invalid" }, { ...base, target: { ...target } }];
    for (const key of Object.keys(base)) {
      const missing = { ...base } as Record<string, unknown>;
      delete missing[key];
      invalid.push(missing);
    }
    for (const value of invalid) {
      const requests = responseFrom(() => reply(value));
      await expect(transport.inspect(target)).rejects.toThrow();
      expect(requests).toHaveLength(1);
    }
  }
});

test("invalid endpoint, owner and target are refused before fetch", async () => {
  const requests = responseFrom(() => reply(observation()));
  for (const invalid of [
    { ...endpoint, origin: "file:///tmp/browser" }, { ...endpoint, origin: "https://fixture.invalid/path" },
    { ...endpoint, origin: "https://user:password@fixture.invalid" }, { ...endpoint, origin: "https://fixture.invalid?host=other" },
    { ...endpoint, hostId: "" }, { ...endpoint, hostId: "host\nforeign" },
  ]) expect(() => new BrowserObservationTransport(invalid, session)).toThrow();
  for (const invalid of [null, {}, { ...session, sessionId: "" }, { ...session, sessionId: "bad\0id" },
    { ...session, extra: true }, { ...draft, draftRevision: 0 }, { ...draft, draftRevision: 1.5 },
    { ...draft, ownerId: "" }, { ...draft, draftId: "" }, { ...draft, sessionId: "session" },
  ]) expect(() => new BrowserObservationTransport(endpoint, invalid as BrowserObservationOwner)).toThrow();
  const transport = new BrowserObservationTransport(endpoint, session);
  for (const invalid of [null, {}, { ...target, workerPid: 0 }, { ...target, workerPid: 1.5 },
    { ...target, workerPid: Number.MAX_SAFE_INTEGER + 1 }, { ...target, name: "" }, { ...target, targetId: "" },
    { ...target, targetId: "bad\0id" }, { ...target, url: "https://replacement.invalid" },
  ]) await expect(transport.inspect(invalid as BrowserFrameTarget)).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

test("host errors preserve status and code, and neither errors nor malformed replies trigger fallback or retry", async () => {
  for (const owner of [session, draft]) {
    const transport = new BrowserObservationTransport(endpoint, owner);
    for (const [status, code] of [[400, "INVALID_BROWSER_OBSERVATION_REQUEST"], [401, "UNAUTHORIZED"], [404, "NOT_FOUND"],
      [409, "STALE_TARGET"], [429, "BROWSER_OBSERVATION_BUSY"], [503, "BROWSER_OBSERVATION_FAILED"]] as const) {
      const requests = responseFrom(() => reply({ error: { code, message: "Original target unavailable" } }, status));
      const result = await transport.inspect(target).catch(error => error);
      expect(result).toBeInstanceOf(HostRequestError);
      expect(result).toMatchObject({ status, code });
      expect(requests).toHaveLength(1);
    }
    for (const response of [reply(observation(owner, target, "absent"), 500), reply({}, 502),
      new Response("{malformed", { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } }),
      new Response(null, { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } }),
    ]) {
      const requests = responseFrom(() => response);
      await expect(transport.inspect(target)).rejects.toThrow();
      expect(requests).toHaveLength(1);
    }
    const requests = responseFrom(() => { throw new Error("Controlled network failure"); });
    await expect(transport.inspect(target)).rejects.toThrow("Controlled network failure");
    expect(requests).toHaveLength(1);
  }
});

test("missing or foreign host headers cancel success and error bodies before any read", async () => {
  const transport = new BrowserObservationTransport(endpoint, session);
  for (const status of [200, 409, 503]) {
    for (const host of [undefined, "foreign"]) {
      let reads = 0, cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull() { reads++; }, cancel() { cancelled++; },
      }, { highWaterMark: 0 });
      const requests = responseFrom(() => new Response(body, { status,
        headers: host ? { [BROWSER_METADATA_OWNER_HEADER]: host } : {},
      }));
      await expect(transport.inspect(target)).rejects.toThrow();
      expect({ reads, cancelled }).toEqual({ reads: 0, cancelled: 1 });
      expect(requests).toHaveLength(1);
    }
  }
});

test("JSON reads enforce separate success and error byte limits and cancel oversized streams", async () => {
  const transport = new BrowserObservationTransport(endpoint, session);
  for (const [status, limit, value] of [
    [200, 32_768, observation()],
    [503, 16_384, { error: { code: "BROWSER_OBSERVATION_FAILED", message: "Unavailable" } }],
  ] as const) {
    const json = JSON.stringify(value);
    // Whitespace padding remains valid JSON, so only the byte bound can reject it.
    responseFrom(() => new Response(json.padEnd(limit, " "), { status, headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } }));
    if (status === 200) expect(await transport.inspect(target)).toEqual(value);
    else expect(await transport.inspect(target).catch(error => error)).toMatchObject({ status, code: "BROWSER_OBSERVATION_FAILED" });
    let cancelled = 0, reads = 0;
    responseFrom(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new TextEncoder().encode(json.padEnd(limit + 1, " "))); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { status, headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } }));
    await expect(transport.inspect(target)).rejects.toThrow("exceeds its limit");
    expect({ cancelled, reads }).toEqual({ cancelled: 1, reads: 1 });
  }
});

test("a controlled 20-second timeout aborts one request without manufacturing absence", async () => {
  for (const owner of [session, draft]) {
    const controller = new AbortController();
    const timeouts: number[] = [];
    AbortSignal.timeout = milliseconds => { timeouts.push(milliseconds); return controller.signal; };
    const requests = responseFrom(request => new Promise<Response>((_, reject) => {
      if (request.signal.aborted) reject(request.signal.reason);
      else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }));
    const work = new BrowserObservationTransport(endpoint, owner).inspect(target);
    const rejected = work.catch(error => error);
    controller.abort(new Error("Controlled observation timeout"));
    expect(await rejected).toMatchObject({ message: "Controlled observation timeout" });
    expect(timeouts).toEqual([20_000]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
  }
});

test("actual host route coalesces overlapping reads on the original existing handle; desktop never caches observations", async () => {
  for (const owner of [session, draft]) {
    const gate = Promise.withResolvers<WorkerBrowserObservation>();
    const entered = Promise.withResolvers<void>();
    const secondAdmission = Promise.withResolvers<void>();
    let inspections = 0, ready = true;
    let awaitingSecondAdmission = false;
    const current = () => { if (awaitingSecondAdmission) secondAdmission.resolve(); return ready; };
    const seenTargets: BrowserFrameTarget[] = [];
    const handle = { id: ownerId(owner), workerPid: target.workerPid,
      inspectBrowserTab: async (input: BrowserFrameTarget): Promise<WorkerBrowserObservation> => {
        seenTargets.push({ ...input }); inspections++;
        entered.resolve();
        if (inspections === 1) return await gate.promise;
        return { ...target, ownerId: ownerId(owner), kindTag: "headless", presence: "absent" };
      },
    };
    const http = new BrowserObservationHttp({ hostId: endpoint.hostId,
      sessionExists: id => { expect(owner.kind).toBe("session"); expect(id).toBe(ownerId(owner)); return current(); },
      getSessionHandle: async id => { expect(owner.kind).toBe("session"); expect(id).toBe(ownerId(owner)); return handle; },
      draftReady: request => { expect(owner.kind).toBe("draft"); expect(request).toEqual({ hostId: "host", ownerId: "draft-owner", draftId: "draft", draftRevision: 1 }); return current(); },
      getDraftHandle: async request => { expect(owner.kind).toBe("draft"); expect(request).toEqual({ hostId: "host", ownerId: "draft-owner", draftId: "draft", draftRevision: 1 }); return handle; },
    });
    cleanups.push(() => http.dispose());
    const requests = responseFrom(request => {
      const response = http.route(request);
      return response.then(value => value ?? new Response(null, { status: 404 }));
    });
    const transport = new BrowserObservationTransport(endpoint, owner);
    const first = transport.inspect(target);
    await entered.promise;
    awaitingSecondAdmission = true;
    const second = transport.inspect(target);
    await secondAdmission.promise;
    awaitingSecondAdmission = false;
    gate.resolve({ ...target, ownerId: ownerId(owner), kindTag: "headless", presence: "present" });
    expect(await Promise.all([first, second])).toEqual([observation(owner), observation(owner)]);
    expect(requests).toHaveLength(2);
    expect(inspections).toBe(1);
    expect(await transport.inspect(target)).toEqual(observation(owner, target, "absent"));
    expect(inspections).toBe(2);
    expect(seenTargets).toEqual([target, target]);
    ready = false;
    expect(await transport.inspect(target).catch(error => error)).toMatchObject({ status: 409, code: "STALE_TARGET" });
    expect(inspections).toBe(2);
    expect(requests).toHaveLength(4);
  }
});
