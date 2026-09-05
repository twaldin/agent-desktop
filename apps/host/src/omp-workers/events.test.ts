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
  expect(projectWorkerEvent({ type: "agent_end", messages: [], isTerminal: true })).toEqual({ type: "agent_end", isTerminal: true });
  const requested: OmpBridgeEvent = { type: "extension_interaction_requested", interaction: { id: "request", sessionId: "session", method: "confirm", title: "Permission", actions: [], createdAt: 1 } };
  expect(projectWorkerEvent(requested)).toBe(requested);
  expect(remoteError(new Error(`Native error with data:image/png;base64,${"A".repeat(8192)}`))).toEqual({ name: "Error", message: "Native error with [image payload omitted]" });
});
