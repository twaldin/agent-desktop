import { expect, test } from "bun:test";
import { projectWorkerEvent } from "./events";
import { Effort } from "@oh-my-pi/pi-ai";
import type { OmpBridgeEvent } from "../omp";
import { remoteError } from "./protocol";

test("worker projection retains lifecycle/thinking/error fields without reading image or provider bodies", () => {
  const raw = { type: "message_end", message: { role: "assistant", errorMessage: `Visible native error ${"A".repeat(8192)}`,
    get content() { throw new Error("Projection must not read an image payload"); },
    get providerPayload() { throw new Error("Projection must not inspect provider payload"); } } };
  expect(projectWorkerEvent(raw as never)).toEqual({ type: "message_end", message: { role: "assistant", errorMessage: "Visible native error [encoded payload omitted]" } });
  expect(projectWorkerEvent({ type: "thinking_level_changed", thinkingLevel: Effort.High, configured: "auto", resolved: Effort.High })).toEqual({
    type: "thinking_level_changed", thinkingLevel: "high", configured: "auto", resolved: "high",
  });
  expect(projectWorkerEvent({ type: "agent_end", messages: [], isTerminal: true })).toEqual({ type: "agent_end", isTerminal: true, activityChanged: true });
  expect(projectWorkerEvent({ type: "goal_updated", goal: null })).toEqual({ type: "goal_updated", activityChanged: true });
  const requested: OmpBridgeEvent = { type: "extension_interaction_requested", interaction: { id: "request", sessionId: "session", method: "confirm", title: "Permission", actions: [], createdAt: 1 } };
  expect(projectWorkerEvent(requested)).toBe(requested);
  expect(remoteError(new Error(`Native error with data:image/png;base64,${"A".repeat(8192)}`))).toEqual({ name: "Error", message: "Native error with [image payload omitted]" });
});

test("remote errors retain bounded nested cleanup diagnostics without exposing arbitrary payloads", () => {
  const leaf = new Error(`Target detached ${"A".repeat(8192)}`);
  const reservation = new AggregateError([leaf, { get credential() { throw new Error("must not inspect payload"); } }], "Browser owner reservation cleanup failed");
  const cleanup = Object.assign(new AggregateError([reservation], "OMP worker native cleanup failed"), { code: "OUTCOME_UNKNOWN" as const });
  Object.assign(cleanup, { cause: cleanup });
  const projected = remoteError(cleanup);
  expect(projected).toMatchObject({ name: "AggregateError", code: "OUTCOME_UNKNOWN" });
  expect(projected.message).toContain("OMP worker native cleanup failed");
  expect(projected.message).toContain("Browser owner reservation cleanup failed");
  expect(projected.message).toContain("Target detached [encoded payload omitted]");
  expect(projected.message).toContain("[cyclic error omitted]");
  expect(projected.message).not.toContain("must not inspect payload");
  expect(projected.message.length).toBeLessThanOrEqual(4096);

  const guardedErrors = Array.from({ length: 64 }, (_, index) => new Error(`failure ${index}`));
  const wideAggregate = new AggregateError(guardedErrors, "wide cleanup");
  Object.defineProperty(wideAggregate.errors, 16, { get() { throw new Error("must not inspect beyond detail budget"); } });
  const wide = remoteError(wideAggregate);
  expect(wide.message).toContain("failure 0");
  expect(wide.message).toContain("[additional error details omitted]");
  expect(wide.message).not.toContain("failure 63");
  expect(wide.message.length).toBeLessThanOrEqual(4096);
});
