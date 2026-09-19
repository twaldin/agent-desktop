import { expect, test } from "bun:test";
import { parseTodoExternalEditorRequest, parseTodoExternalEditorObservation, parseTodoExternalEditorRecovery } from "./todo-external-editor";
const request = { requestId: crypto.randomUUID(), controlEpoch: crypto.randomUUID(), sessionId: "native",
  ticket: { nativeSessionId: "native", epoch: "epoch", revision: "revision" } };
test("Todo editor requests reject mixed Plan authority, private inputs and mismatched native owners", () => {
  expect(parseTodoExternalEditorRequest(request)).toEqual(request);
  for (const extra of [{ edit: { kind: "plan" } }, { cwd: "/private" }, { environment: {} }, { editorCommand: "editor" }])
    expect(() => parseTodoExternalEditorRequest({ ...request, ...extra })).toThrow("keys");
  expect(() => parseTodoExternalEditorRequest({ ...request, sessionId: "another" })).toThrow("owner");
});
test("applied receipts must belong to the original Todo native owner and command", () => {
  const value = { protocolVersion: 1, hostId: "host", request, state: "settled", result: { outcome: "applied", receipt: {
    commandId: request.requestId, state: { ticket: request.ticket, markdown: "# Todos\n", phases: [], nativeCommandAvailable: true,
      reconciliationRequired: false }, output: "Saved" } } };
  expect(parseTodoExternalEditorObservation(value, "host", request).result?.outcome).toBe("applied");
  expect(() => parseTodoExternalEditorObservation({ ...value, result: { outcome: "applied" } }, "host", request)).toThrow("receipt");
  const wrong = structuredClone(value); wrong.result.receipt.state.ticket.epoch = "replacement";
  expect(() => parseTodoExternalEditorObservation(wrong, "host", request)).toThrow("owner");
  expect(() => parseTodoExternalEditorRecovery({ observation: value, content: "old output" }, "host", request)).toThrow("recovery state");
});

 test("recovery requires an explicit original-input or completed-output source", () => {
  const observation = { protocolVersion: 1, hostId: "host", request, state: "settled", result: { outcome: "unknown" } };
  for (const source of ["original-input", "completed-output"] as const)
    expect(parseTodoExternalEditorRecovery({ observation, content: "text", source }, "host", request).source).toBe(source);
  expect(() => parseTodoExternalEditorRecovery({ observation, content: "text" }, "host", request)).toThrow("source");
  expect(() => parseTodoExternalEditorRecovery({ observation, source: "original-input" }, "host", request)).toThrow("source");
 });
