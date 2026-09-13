import { describe, expect, test } from "bun:test";
import { MAX_PLAN_ANNOTATION_BYTES } from "./plan-document";
import { parsePlanExternalEditorCapabilities, parsePlanExternalEditorObservation, parsePlanExternalEditorRequest,
  type PlanExternalEditorRequest } from "./plan-external-editor";

const ids = {
  requestId: "10000000-0000-0000-0000-000000000001",
  controlEpoch: "20000000-0000-0000-0000-000000000002",
  terminalId: "30000000-0000-0000-0000-000000000003",
};
const revision = "a".repeat(64), ticketRevision = "b".repeat(64);
const base = (edit: PlanExternalEditorRequest["edit"] = { kind: "plan" }): PlanExternalEditorRequest => ({
  requestId: ids.requestId,
  controlEpoch: ids.controlEpoch,
  sessionId: "session-one",
  ticket: { epoch: "plan-epoch", nativeSessionId: "native-one", revision: ticketRevision },
  reviewId: "review-one",
  reviewRevision: revision,
  documentRevision: "native-document-one",
  edit,
});
const receipt = (request: PlanExternalEditorRequest, outcome: "applied" | "cancelled" | "unknown" = "applied") => ({
  commandId: request.requestId,
  reviewId: request.reviewId,
  reviewRevision: request.reviewRevision,
  action: request.edit.kind === "plan" ? "edit" as const : "document" as const,
  outcome,
  artifact: outcome === "unknown" ? "unknown" as const : outcome === "applied" ? "written" as const : "unchanged" as const,
  transition: "unchanged" as const,
  execution: "not-requested" as const,
});

describe("Plan external editor shared wire", () => {
  test("parses exact Plan and empty annotation drafts into detached values", () => {
    const raw: any = base();
    const parsed = parsePlanExternalEditorRequest(raw);
    raw.ticket.epoch = "changed";
    raw.edit.kind = "annotation";
    expect(parsed).toEqual(base());

    const annotation = base({ kind: "annotation", target: { kind: "line", sectionId: "section-one", rowId: "row-one" }, note: "", renderColumns: 96 });
    const parsedAnnotation = parsePlanExternalEditorRequest(annotation);
    (annotation.edit as any).target.rowId = "changed";
    expect(parsedAnnotation.edit).toEqual({ kind: "annotation", target: { kind: "line", sectionId: "section-one", rowId: "row-one" }, note: "", renderColumns: 96 });
    expect(parsePlanExternalEditorRequest(base({ kind: "annotation", target: { kind: "section", sectionId: "section-one" }, note: "draft", renderColumns: 20 })).edit)
      .toEqual({ kind: "annotation", target: { kind: "section", sectionId: "section-one" }, note: "draft", renderColumns: 20 });
  });

  test("bounds annotation UTF-8 bytes and rejects paths, commands, and unknown nested keys", () => {
    const exact = "😀".repeat(MAX_PLAN_ANNOTATION_BYTES / 4);
    expect((parsePlanExternalEditorRequest(base({ kind: "annotation", target: { kind: "section", sectionId: "one" }, note: exact, renderColumns: 240 })).edit as any).note).toBe(exact);
    expect(() => parsePlanExternalEditorRequest(base({ kind: "annotation", target: { kind: "section", sectionId: "one" }, note: exact + "a", renderColumns: 80 }))).toThrow("text");
    expect(() => parsePlanExternalEditorRequest({ ...base(), command: "code" })).toThrow("keys");
    expect(() => parsePlanExternalEditorRequest({ ...base(), path: "/tmp/plan.md" })).toThrow("keys");
    expect(() => parsePlanExternalEditorRequest(base({ kind: "annotation", target: { kind: "line", sectionId: "one", rowId: "row", sourceLine: 4 } as any, note: "x", renderColumns: 80 }))).toThrow("keys");
    expect(() => parsePlanExternalEditorRequest(base({ kind: "annotation", target: { kind: "section", sectionId: "one" }, note: "x", renderColumns: 19 }))).toThrow("render columns");
  });

  test("capabilities bind the host and epoch while never admitting configured command disclosure", () => {
    expect(parsePlanExternalEditorCapabilities({ protocolVersion: 1, hostId: "host-one", controlEpoch: ids.controlEpoch, available: true }, "host-one"))
      .toEqual({ protocolVersion: 1, hostId: "host-one", controlEpoch: ids.controlEpoch, available: true });
    expect(parsePlanExternalEditorCapabilities({ protocolVersion: 1, hostId: "host-one", controlEpoch: ids.controlEpoch, available: false, reason: "No editor is configured." }, "host-one").reason)
      .toBe("No editor is configured.");
    expect(() => parsePlanExternalEditorCapabilities({ protocolVersion: 1, hostId: "other", controlEpoch: ids.controlEpoch, available: true }, "host-one")).toThrow("owner");
    expect(() => parsePlanExternalEditorCapabilities({ protocolVersion: 1, hostId: "host-one", controlEpoch: ids.controlEpoch, available: false }, "host-one")).toThrow("reason");
    expect(() => parsePlanExternalEditorCapabilities({ protocolVersion: 1, hostId: "host-one", controlEpoch: ids.controlEpoch, available: true, reason: "hidden", command: "code" }, "host-one")).toThrow("keys");
  });

  test("accepts absent, capture-phase pending, and truthful settled outcomes", () => {
    const request = base();
    expect(parsePlanExternalEditorObservation({ protocolVersion: 1, hostId: "host-one", request, state: "absent" }, "host-one", request).state).toBe("absent");
    expect(parsePlanExternalEditorObservation({ protocolVersion: 1, hostId: "host-one", request, state: "pending" }, "host-one", request).state).toBe("pending");
    expect(parsePlanExternalEditorObservation({ protocolVersion: 1, hostId: "host-one", request, state: "pending", terminalId: ids.terminalId }, "host-one", request).terminalId).toBe(ids.terminalId);
    for (const outcome of ["cancelled", "unknown"] as const) {
      const parsed = parsePlanExternalEditorObservation({ protocolVersion: 1, hostId: "host-one", request, state: "settled", terminalId: ids.terminalId,
        result: { outcome, receipt: receipt(request, outcome), message: "Editor finished." } }, "host-one", request);
      expect(parsed.result?.outcome).toBe(outcome);
    }
    expect(parsePlanExternalEditorObservation({ protocolVersion: 1, hostId: "host-one", request, state: "settled",
      result: { outcome: "not-submitted", message: "Launch was refused." } }, "host-one", request).result?.outcome).toBe("not-submitted");
  });

  test("applied results bind the original request, review, and edit action", () => {
    for (const request of [base(), base({ kind: "annotation", target: { kind: "section", sectionId: "section-one" }, note: "", renderColumns: 80 })]) {
      const raw: any = { protocolVersion: 1, hostId: "host-one", request, state: "settled", terminalId: ids.terminalId,
        result: { outcome: "applied", receipt: receipt(request), message: "Applied." } };
      const parsed = parsePlanExternalEditorObservation(raw, "host-one", request);
      raw.request.ticket.epoch = "changed";
      raw.result.receipt.message = "changed";
      expect(parsed.request.ticket.epoch).toBe("plan-epoch");
      expect(parsed.result?.receipt).toEqual(receipt(request));
    }
  });

  test("rejects cross-owner, changed payload, unknown state keys, and contradictory receipts", () => {
    const request = base(), applied = { protocolVersion: 1, hostId: "host-one", request, state: "settled", terminalId: ids.terminalId,
      result: { outcome: "applied", receipt: receipt(request) } };
    expect(() => parsePlanExternalEditorObservation({ ...applied, hostId: "other" }, "host-one", request)).toThrow("owner");
    expect(() => parsePlanExternalEditorObservation({ ...applied, request: { ...request, controlEpoch: "40000000-0000-0000-0000-000000000004" } }, "host-one", request)).toThrow("request");
    expect(() => parsePlanExternalEditorObservation({ ...applied, request: { ...request, edit: { kind: "annotation", target: { kind: "section", sectionId: "other" }, note: "", renderColumns: 80 } } }, "host-one", request)).toThrow("request");
    expect(() => parsePlanExternalEditorObservation({ ...applied, processId: 42 }, "host-one", request)).toThrow("keys");
    expect(() => parsePlanExternalEditorObservation({ ...applied, state: "pending" }, "host-one", request)).toThrow("non-settled");
    expect(() => parsePlanExternalEditorObservation({ ...applied, result: { outcome: "cancelled", receipt: receipt(request) } }, "host-one", request)).toThrow("contradictory");
    expect(() => parsePlanExternalEditorObservation({ ...applied, result: { outcome: "applied", receipt: { ...receipt(request), reviewId: "other" } } }, "host-one", request)).toThrow("owner");
    expect(() => parsePlanExternalEditorObservation({ ...applied, result: { outcome: "applied", receipt: { ...receipt(request), transition: "new-session", destinationSessionId: "other" } } }, "host-one", request)).toThrow("applied receipt");
    expect(() => parsePlanExternalEditorObservation({ ...applied, result: { outcome: "not-submitted", receipt: { ...receipt(request), outcome: "cancelled", artifact: "unchanged" } } }, "host-one", request)).toThrow("not-submitted");
    expect(() => parsePlanExternalEditorObservation({ protocolVersion: 1, hostId: "host-one", request, state: "absent", terminalId: ids.terminalId }, "host-one", request)).toThrow("absent");
  });
});
