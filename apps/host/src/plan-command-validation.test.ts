import { expect, test } from "bun:test";
import { parseCommandEnvelope } from "./validation";
import { parsePlanDecisionPreparation } from "./omp/plan-decision";

const binding = { sessionId: "session", ticket: { epoch: "owner", nativeSessionId: "session", revision: "a".repeat(64) } };
test("Plan decisions require the exact versioned endpoint and retain empty native refinement", () => {
  const command = { type: "session.plan.mutate", ...binding, reviewId: "review", reviewRevision: "b".repeat(64), mutation: { action: "refine", text: "" } } as const;
  const value = { id: "decision", commandVersion: 19, command } as const;
  expect(parseCommandEnvelope(value, 19)).toEqual(value);
  for (const version of [undefined, 1, 18]) expect(() => parseCommandEnvelope({ ...value, commandVersion: version })).toThrow();
  expect(() => parseCommandEnvelope(value, 18)).toThrow();
  expect(() => parseCommandEnvelope({ ...value, command: { ...command, readPath: "/other/plan" } }, 19)).toThrow();
  const parsed = parseCommandEnvelope(value, 19);
  command.ticket.epoch = "replacement";
  expect(parsed.command).toMatchObject({ ticket: { epoch: "owner" }, mutation: { action: "refine", text: "" } });
});

test("Plan document mutations require command version 20 and its exact transport while legacy decisions remain valid", () => {
  const command = { type: "session.plan.mutate", ...binding, reviewId: "review", reviewRevision: "b".repeat(64),
    mutation: { action: "document", renderColumns: 120,
      documentAction: { kind: "undo", expectedDocumentRevision: "document-revision" } } } as const;
  const value = { id: "document-decision", commandVersion: 20, command } as const;
  expect(parseCommandEnvelope(value, 20)).toEqual(value);
  expect(() => parseCommandEnvelope({ ...value, commandVersion: 19 }, 20)).toThrow("command version 20");
  expect(() => parseCommandEnvelope(value, 19)).toThrow("version 20 endpoint");
  expect(() => parseCommandEnvelope({ id: value.id, command }, 20)).toThrow("command version 20");

  const legacy = { id: "legacy-decision", commandVersion: 19, command: { ...command,
    mutation: { action: "edit", content: "# Exact Plan" } } } as const;
  expect(parseCommandEnvelope(legacy, 19)).toEqual(legacy);
  expect(parseCommandEnvelope(legacy, 20)).toEqual(legacy);
  const current = { ...legacy, commandVersion: 20 } as const;
  expect(parseCommandEnvelope(current, 20)).toEqual(current);
});

test("internal phase handoff binds actual replacement and never grants execution from an unknown result", () => {
  const receipt = { commandId: "decision", reviewId: "review", reviewRevision: "b".repeat(64), action: "approve",
    outcome: "applied", artifact: "unchanged", transition: "new-session", destinationSessionId: "next", execution: "not-entered" } as const;
  const value = { receipt, execution: { phaseId: "phase" }, transition: { nativeSessionId: "next", sessionFile: "/native/next.jsonl" } };
  expect(parsePlanDecisionPreparation(value, "decision")).toEqual(value);
  expect(() => parsePlanDecisionPreparation({ ...value, transition: { ...value.transition, nativeSessionId: "other" } }, "decision")).toThrow();
  expect(() => parsePlanDecisionPreparation({ ...value, receipt: { ...receipt, outcome: "unknown", execution: "unknown" } }, "decision")).toThrow();
  expect(() => parsePlanDecisionPreparation({ receipt }, "decision")).toThrow();
  expect(parsePlanDecisionPreparation({ receipt: { ...receipt, outcome: "unknown", transition: "unknown", execution: "unknown" }, transition: value.transition }, "decision"))
    .toMatchObject({ receipt: { outcome: "unknown", destinationSessionId: "next" } });
});
