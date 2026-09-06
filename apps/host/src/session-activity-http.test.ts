import { expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER, type NativeSessionActivity } from "@agent-desktop/shared";
import { SessionActivityHttp } from "./session-activity-http";

const activity: NativeSessionActivity = {
  goal: { availability: "available", value: null },
  jobs: { availability: "unavailable", reason: "No manager" },
  agents: { availability: "available", value: [] },
  sources: { availability: "unsupported", reason: "No source registry" },
};
const request = (owner = "owner") => new Request("http://host/v1/sessions/native/activity", { headers: { [SESSION_ACTIVITY_OWNER_HEADER]: owner } });

test("session activity binds the response to an existing owner and session", async () => {
  const http = new SessionActivityHttp({ hostId: "owner", sessionExists: id => id === "native", getActivity: async () => activity });
  const response = await http.route(request());
  expect(response?.status).toBe(200); expect(response?.headers.get(SESSION_ACTIVITY_OWNER_HEADER)).toBe("owner");
  expect(await response?.json()).toEqual({ protocolVersion: 1, hostId: "owner", sessionId: "native", ...activity });
});

test("session activity distinguishes owner mismatch and stale session", async () => {
  let calls = 0;
  const http = new SessionActivityHttp({ hostId: "owner", sessionExists: () => false, getActivity: async () => { calls++; return activity; } });
  const wrong = await http.route(request("other")); expect(wrong?.status).toBe(409);
  expect(await wrong?.json()).toMatchObject({ error: { code: "OWNER_MISMATCH" } });
  const stale = await http.route(request()); expect(stale?.status).toBe(409);
  expect(await stale?.json()).toMatchObject({ error: { code: "STALE_TARGET" } }); expect(calls).toBe(0);
});

test("session activity exposes an optional goal control ticket from the exact native projection", async () => {
  const ticket = { controlEpoch: "epoch", observedAt: 123, goalFingerprint: "a".repeat(64) };
  const http = new SessionActivityHttp({ hostId: "owner", sessionExists: () => true, getActivity: async () => activity,
    goalControlTicket: value => { expect(value).toBe(activity); return ticket; } });
  expect(await (await http.route(request()))!.json()).toMatchObject({ goalControlTicket: ticket });
});
