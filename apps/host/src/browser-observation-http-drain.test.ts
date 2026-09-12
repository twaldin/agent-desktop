import { expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameTarget } from "@agent-desktop/shared";
import { BrowserObservationHttp } from "./browser-observation-http";
import type { WorkerBrowserObservation } from "./omp-browser/observation";

const target: BrowserFrameTarget = { workerPid: 41, name: "main", targetId: "original" };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(kind: "session" | "draft") {
  const gates = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()];
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let reads = 0, lookups = 0;
  const value = (index: number): WorkerBrowserObservation => ({ ...target, targetId: index ? "other" : target.targetId,
    ownerId: "owner", kindTag: "headless", presence: "present" });
  const handle = { id: "owner", workerPid: 41, inspectBrowserTab: async () => {
    const index = reads++; started[index]!.resolve();
    // Deliberately model an invalid external reply at the typed worker boundary.
    return await gates[index]!.promise as WorkerBrowserObservation;
  } };
  const lookup = async () => { lookups++; return handle; };
  const http = new BrowserObservationHttp({ hostId: "host", sessionExists: () => true, getSessionHandle: lookup,
    draftReady: () => true, getDraftHandle: lookup });
  const request = (index: number) => {
    const input = { ...target, targetId: index ? "other" : target.targetId };
    const headers = { [BROWSER_METADATA_OWNER_HEADER]: "host", "content-type": "application/json" };
    return kind === "session"
      ? new Request("https://fixture.invalid/v1/sessions/owner/browser-target-observation?" + new URLSearchParams({ workerPid: "41", name: input.name, targetId: input.targetId }), { headers })
      : new Request("https://fixture.invalid/v1/draft-browser-owners/owner/target-observation", { method: "POST", headers,
        body: JSON.stringify({ draftId: "draft", draftRevision: 1, target: input }) });
  };
  return { http, request, gates, started, value, counts: () => ({ reads, lookups }) };
}

for (const kind of ["session", "draft"] as const) {
  test(`${kind} malformed dispatched result remains a drain error while another read is held`, async () => {
    const f = fixture(kind), first = f.http.route(f.request(0)), second = f.http.route(f.request(1));
    await Promise.all(f.started.map(value => value.promise));
    let settled = false;
    const drain = f.http.dispose().then(() => { settled = true; return { ok: true as const }; }, error => {
      settled = true; return { ok: false as const, error };
    });
    try {
      f.gates[0]!.resolve({ ...f.value(0), presence: "unknown" });
      await flush(); expect(settled).toBe(false);
      f.gates[1]!.resolve(f.value(1));
      const outcome = await drain;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Malformed dispatched observation was reported as a clean drain");
      expect(outcome.error).toBeInstanceOf(AggregateError);
      expect((outcome.error as AggregateError).errors).toHaveLength(1);
      expect((outcome.error as AggregateError).errors[0]).toBeInstanceOf(Error);
      expect((await first)!.status).toBe(503); expect((await second)!.status).toBe(503);
      const repeated = await f.http.dispose().then(() => undefined, error => error);
      expect(repeated).toBeInstanceOf(AggregateError);
      expect((repeated as AggregateError).errors).toHaveLength(1);
      const before = f.counts();
      expect((await f.http.route(f.request(0)))!.status).toBe(503);
      expect(f.counts()).toEqual(before);
    } finally {
      f.gates.forEach((gate, index) => gate.resolve(f.value(index)));
      await Promise.allSettled([first, second, drain, f.http.dispose()]);
    }
  });

  test(`${kind} valid dispatched result after retirement is suppressed without inventing a parse error`, async () => {
    const f = fixture(kind), response = f.http.route(f.request(0));
    await f.started[0]!.promise;
    let settled = false;
    const drain = f.http.dispose().then(() => { settled = true; });
    try {
      await flush(); expect(settled).toBe(false);
      f.gates[0]!.resolve(f.value(0)); await drain;
      expect(settled).toBe(true);
      expect(await (await response)!.json()).toMatchObject({ error: { code: "BROWSER_OBSERVATION_STOPPING" } });
      await f.http.dispose();
      expect(f.counts()).toEqual({ reads: 1, lookups: 1 });
    } finally {
      f.gates[0]!.resolve(f.value(0));
      await Promise.allSettled([response, drain, f.http.dispose()]);
    }
  });
}
