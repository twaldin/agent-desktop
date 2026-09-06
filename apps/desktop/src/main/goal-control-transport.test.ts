import { afterAll, expect, test } from "bun:test";
import { SESSION_ACTIVITY_OWNER_HEADER, type GoalMutationRequest } from "@agent-desktop/shared";
import { requestGoalMutation } from "./goal-control-transport";

const request: GoalMutationRequest = {
  requestId: "request-1", controlEpoch: "epoch-1", observedAt: 1_000, goalFingerprint: "a".repeat(64),
  expectedGoal: null, mutation: { type: "create", objective: "test goal" },
};
const goal = { id: "goal-1", objective: "test goal", status: "active" as const, enabled: true, mode: "active" as const,
  tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1_000, updatedAt: 1_000 };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(input) {
  const path = new URL(input.url).pathname;
  const response = (body: unknown, status = 200, owner = "owner") => Response.json(body, { status, headers: { [SESSION_ACTIVITY_OWNER_HEADER]: owner } });
  if (path.includes("/wrong-host/")) return response({ error: { code: "OWNER_MISMATCH", message: "Wrong host" } }, 409, "other");
  if (path.includes("/invalid/")) return response({ error: { code: "INVALID_GOAL_CONTROL_REQUEST", message: "Invalid request" } }, 400);
  if (path.includes("/unknown/")) return response({ error: { code: "SESSION_ACTIVITY_FAILED", message: "Worker outcome unknown" } }, 500);
  if (path.includes("/malformed/")) return response({ protocolVersion: 1, hostId: "owner", sessionId: "session", requestId: "request-1", outcome: "completed", goal: { id: "bad" } });
  return response({ protocolVersion: 1, hostId: "owner", sessionId: "session", requestId: "request-1", outcome: "completed", goal });
} });
const endpoint = (route: string) => ({ origin: `${server.url.origin}/${route}`, hostId: "owner" });
afterAll(() => server.stop(true));

test("goal transport accepts an exact completed receipt", async () => {
  await expect(requestGoalMutation(endpoint("ok"), "session", request)).resolves.toMatchObject({ outcome: "completed", goal: { id: "goal-1" } });
});

test("goal transport preserves definite rejection and unknown outcomes", async () => {
  await expect(requestGoalMutation(endpoint("invalid"), "session", request)).resolves.toMatchObject({ outcome: "rejected", message: "Invalid request" });
  await expect(requestGoalMutation(endpoint("wrong-host"), "session", request)).rejects.toThrow(/another host/);
  await expect(requestGoalMutation(endpoint("unknown"), "session", request)).rejects.toThrow(/outcome is unknown/);
});

test("goal transport rejects malformed completed payloads", async () => {
  await expect(requestGoalMutation(endpoint("malformed"), "session", request)).rejects.toThrow(/Invalid native goal activity/);
  await expect(requestGoalMutation(endpoint("ok"), "other", request)).rejects.toThrow(/invalid|unknown/i);
});
