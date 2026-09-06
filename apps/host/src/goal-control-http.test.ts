import { expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER, type GoalMutationRequest, type NativeGoalActivity, type NativeSessionActivity } from "@agent-desktop/shared";
import { GoalControlHttp } from "./goal-control-http";

const nativeGoal = (update: Partial<NativeGoalActivity> = {}): NativeGoalActivity => ({ id: "goal-1", objective: "Native objective", status: "active", enabled: true,
  mode: "active", tokenBudget: 1000, tokensUsed: 10, timeUsedSeconds: 2, createdAt: 10, updatedAt: 20, ...update });
const activity = (goal: NativeGoalActivity | null): NativeSessionActivity => ({ goal: { availability: "available", value: goal }, jobs: { availability: "unavailable", reason: "fixture" },
  agents: { availability: "available", value: [] }, sources: { availability: "unsupported", reason: "fixture" } });

function setup(initial: NativeGoalActivity | null = nativeGoal(), mutate?: (input: GoalMutationRequest) => Promise<NativeGoalActivity | null>) {
  let now = 1_000_000, current = initial, calls = 0, exists = true;
  const handle = { getSessionActivity: async () => activity(current), mutateGoal: async (input: GoalMutationRequest) => {
    calls++; current = mutate ? await mutate(input) : { ...nativeGoal(), updatedAt: 21, tokenBudget: input.mutation.type === "setBudget" ? input.mutation.tokenBudget : 1000 }; return current;
  } };
  let active: typeof handle | undefined = handle;
  let tail: Promise<unknown> = Promise.resolve();
  const http = new GoalControlHttp({ hostId: "owner", sessionExists: () => exists, getHandle: async () => {
    if (!active) throw new Error("missing"); return active;
  }, getExistingHandle: async () => active, ordered: <T>(_id: string, operation: () => Promise<T>) => {
    const pending = tail.catch(() => {}).then(operation); tail = pending; return pending;
  }, now: () => now });
  const ticket = http.ticket(activity(current))!;
  const input: GoalMutationRequest = { requestId: "request-1", ...ticket, expectedGoal: current ? { id: current.id, updatedAt: current.updatedAt } : null,
    mutation: current ? { type: "setBudget", tokenBudget: 2000 } : { type: "create", objective: "Create" } };
  const request = (body: unknown = input, owner = "owner") => new Request("http://host/v1/sessions/session/goal-control", { method: "POST",
    headers: { [SESSION_ACTIVITY_OWNER_HEADER]: owner }, body: JSON.stringify(body) });
  return { http, input, request, calls: () => calls, advance: (ms: number) => now += ms, setCurrent: (goal: NativeGoalActivity | null) => { current = goal; },
    replace: () => { active = undefined; }, remove: () => { exists = false; } };
}

test("goal control binds owner, ticket age, and native configuration fingerprint before mutation", async () => {
  const s = setup();
  expect(s.http.ticket(activity(nativeGoal({ tokenBudget: 0 })))).toBeUndefined();
  expect(s.http.ticket(activity(nativeGoal({ tokenBudget: 1000 })))?.goalFingerprint)
    .not.toBe(s.http.ticket(activity(nativeGoal({ tokenBudget: 1500 })))?.goalFingerprint);
  expect((await s.http.route(s.request(s.input, "other")))?.status).toBe(409);
  expect((await (await s.http.route(s.request({ ...s.input, controlEpoch: "old" })))!.json()).outcome).toBe("rejected");
  s.setCurrent(nativeGoal({ tokenBudget: 1500 })); // Same native id and updatedAt, different exact projection.
  expect((await (await s.http.route(s.request()))!.json()).outcome).toBe("rejected");
  expect(s.calls()).toBe(0);
  const old = setup(); old.advance(60_001);
  expect((await (await old.http.route(old.request()))!.json()).outcome).toBe("rejected"); expect(old.calls()).toBe(0);
  const removed = setup(); removed.remove();
  expect((await (await removed.http.route(removed.request()))!.json()).outcome).toBe("rejected"); expect(removed.calls()).toBe(0);
});

test("native accounting progress does not invalidate control, but identity and configuration changes do", async () => {
  const accounting = setup();
  accounting.setCurrent(nativeGoal({ updatedAt: 900, tokensUsed: 600, timeUsedSeconds: 50 }));
  expect((await (await accounting.http.route(accounting.request()))!.json()).outcome).toBe('completed');
  expect(accounting.calls()).toBe(1);
  for (const change of [
    { id: 'replacement' }, { objective: 'Edited elsewhere' }, { status: 'paused' as const, enabled: false },
    { tokenBudget: 1200 }, { mode: 'exiting' as const, reason: 'completed' as const },
  ]) {
    const s = setup(); s.setCurrent(nativeGoal(change));
    expect((await (await s.http.route(s.request()))!.json()).outcome).toBe('rejected');
    expect(s.calls()).toBe(0);
  }
});

test("concurrent identical mutations share one durable receipt and altered reuse rejects", async () => {
  const gate = Promise.withResolvers<NativeGoalActivity | null>();
  const s = setup(nativeGoal(), async () => gate.promise);
  const first = s.http.route(s.request()), retry = s.http.route(s.request()); await Bun.sleep(5);
  expect(s.calls()).toBe(1); gate.resolve(nativeGoal({ updatedAt: 21, tokenBudget: 2000 }));
  const [a, b] = await Promise.all([first, retry]); expect(await a!.json()).toEqual(await b!.json());
  const changed = await (await s.http.route(s.request({ ...s.input, mutation: { type: "setBudget", tokenBudget: 3000 } })))!.json();
  expect(changed.outcome).toBe("rejected"); expect(s.calls()).toBe(1);
});

test("different mutations are session-ordered and a queued stale projection cannot overwrite the first", async () => {
  const gate = Promise.withResolvers<NativeGoalActivity | null>(), s = setup(nativeGoal(), async () => gate.promise);
  const first = s.http.route(s.request());
  const secondInput = { ...s.input, requestId: "request-2", mutation: { type: "setBudget" as const, tokenBudget: 3000 } };
  const second = s.http.route(s.request(secondInput)); await Bun.sleep(5); expect(s.calls()).toBe(1);
  gate.resolve(nativeGoal({ updatedAt: 21, tokenBudget: 2000 }));
  expect((await (await first)!.json()).outcome).toBe("completed");
  expect((await (await second)!.json()).outcome).toBe("rejected"); expect(s.calls()).toBe(1);
});

test("native preflight rejection and post-dispatch uncertainty stay distinct", async () => {
  for (const name of ["GoalMutationRejected", "Error"]) {
    const s = setup(nativeGoal(), async () => { const error = new Error("private native detail"); error.name = name; if (name === "Error") Object.assign(error, { code: "OUTCOME_UNKNOWN" }); throw error; });
    const receipt = await (await s.http.route(s.request()))!.json();
    expect(receipt.outcome).toBe(name === "GoalMutationRejected" ? "rejected" : "unknown");
    expect(JSON.stringify(receipt)).not.toContain("private"); expect(s.calls()).toBe(1);
  }
});

test("worker replacement after native success is unknown and never replayed", async () => {
  const gate = Promise.withResolvers<NativeGoalActivity | null>(), s = setup(nativeGoal(), async () => gate.promise);
  const pending = s.http.route(s.request()); await Bun.sleep(5); s.replace(); gate.resolve(nativeGoal({ updatedAt: 21 }));
  expect((await (await pending)!.json()).outcome).toBe("unknown");
  expect((await (await s.http.route(s.request()))!.json()).outcome).toBe("unknown"); expect(s.calls()).toBe(1);
});
