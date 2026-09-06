import { expect, test } from "bun:test";
import { parseGoalMutationReceipt, parseGoalMutationRequest, type GoalMutationRequest } from "./goal-control";

const fingerprint = "a".repeat(64);
const request: GoalMutationRequest = { requestId: "request-1", controlEpoch: "epoch-1", observedAt: 1, goalFingerprint: fingerprint,
  expectedGoal: { id: "goal-1", updatedAt: 2 }, mutation: { type: "setBudget", tokenBudget: 1200 } };
const goal = { id: "goal-1", objective: "Finish native work", status: "active" as const, enabled: true, mode: "active" as const,
  tokenBudget: 1200, tokensUsed: 3, timeUsedSeconds: 4, createdAt: 1, updatedAt: 2 };

test("goal mutation parser bounds identity, objective, budget, and exact expected state", () => {
  expect(parseGoalMutationRequest(request)).toEqual(request);
  expect(parseGoalMutationRequest({ ...request, expectedGoal: null, mutation: { type: "create", objective: "new" } })).toMatchObject({ expectedGoal: null });
  for (const invalid of [
    { ...request, goalFingerprint: "short" },
    { ...request, expectedGoal: null },
    { ...request, mutation: { type: "create", objective: " " } },
    { ...request, mutation: { type: "replace", objective: "x", tokenBudget: 0 } },
    { ...request, mutation: { type: "setBudget", tokenBudget: 1.5 } },
  ]) expect(() => parseGoalMutationRequest(invalid)).toThrow();
});

test("goal receipt parser retains only bounded native state and exact ownership", () => {
  const expected = { hostId: "owner", sessionId: "session", requestId: "request-1" };
  expect(parseGoalMutationReceipt({ protocolVersion: 1, ...expected, outcome: "completed", goal, private: true }, expected)).toEqual({ protocolVersion: 1, ...expected, outcome: "completed", goal });
  expect(parseGoalMutationReceipt({ protocolVersion: 1, ...expected, outcome: "unknown", message: "Refresh", goal: null }, expected)).toMatchObject({ outcome: "unknown", goal: null });
  expect(() => parseGoalMutationReceipt({ protocolVersion: 1, ...expected, hostId: "other", outcome: "completed", goal }, expected)).toThrow();
  expect(() => parseGoalMutationReceipt({ protocolVersion: 1, ...expected, outcome: "completed", goal: { ...goal, objective: "x".repeat(16_385) } }, expected)).toThrow();
});
