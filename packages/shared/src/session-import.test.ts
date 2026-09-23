import { expect, test } from "bun:test";
import { parseNativeImportInspection, parseNativeImportListing,parseNativeImportPreparationRequest,parseNativeImportAdmissionRequest,parseNativeImportPreparation,parseNativeImportOutcome } from "./session-import";
const row = { candidateId: "candidate", sourcePath: "/original", title: "", recordedCwd: "", persistedStatus: "unknown" };
const listing = { version: 1, hostId: "host", candidates: [row] };
const inspection = { candidateId: "candidate", revision: "revision", originalFile: "/original", recordedCwd: "", entries: 1, messages: 0, malformedRecords: 0, issues: ["Original cwd is unavailable"], writeAdmission: { allowed: false, reason: "source-invalid" } };
test("blank native summary fields remain inspectable and saved statuses never imply live ownership", () => {
  for (const persistedStatus of ["complete", "interrupted", "aborted", "error", "pending", "unknown"] as const) {
    expect(parseNativeImportListing({ ...listing, candidates: [{ ...row, persistedStatus }] }, "host").candidates[0]!.persistedStatus).toBe(persistedStatus);
  }
  expect(parseNativeImportInspection({ version: 1, hostId: "host", inspection }, "host", "candidate").inspection.writeAdmission).toEqual({ allowed: false, reason: "source-invalid" });
  expect(() => parseNativeImportListing({ ...listing, candidates: [{ ...row, persistedStatus: "running" }] }, "host")).toThrow("saved native status");
});
test("preparation and outcome replies retain original owner, inspected revision and command identity",()=>{
  const preparation={version:1,hostId:"host",candidateId:"candidate",revision:"revision",state:"ready",preparationId:"prepared",original:{sessionId:"native",originalFile:"/original",cwd:"/project"}} as const;
  expect(parseNativeImportPreparation(preparation,"host","candidate","revision")).toEqual(preparation);
  expect(()=>parseNativeImportPreparation(preparation,"host","candidate","new-revision")).toThrow("inspected source");
  expect(()=>parseNativeImportPreparation(preparation,"other","candidate","revision")).toThrow("another host");
  expect(()=>parseNativeImportPreparationRequest({candidateId:"candidate",revision:"revision",path:"/injected"})).toThrow("Unexpected");
  expect(()=>parseNativeImportAdmissionRequest({commandId:"command",preparationId:"/path"})).toThrow("candidate");
  const outcome={version:1,hostId:"host",commandId:"command",state:"imported",original:preparation.original} as const;
  expect(parseNativeImportOutcome(outcome,"host","command")).toEqual(outcome);
  expect(()=>parseNativeImportOutcome(outcome,"host","different")).toThrow("another command");
  expect(()=>parseNativeImportOutcome({...outcome,state:"admitted"},"host","command")).toThrow("Invalid");
});
test("foreign owners, candidate replacement, sparse and duplicate rows and forged writable admission reject", () => {
  expect(() => parseNativeImportListing(listing, "other")).toThrow("another host");
  expect(() => parseNativeImportListing({ ...listing, candidates: new Array(1) }, "host")).toThrow();
  expect(() => parseNativeImportListing({ ...listing, candidates: [row, row] }, "host")).toThrow("Duplicate");
  const reply = { version: 1, hostId: "host", inspection };
  expect(() => parseNativeImportInspection(reply, "host", "replacement")).toThrow("candidate");
  expect(() => parseNativeImportInspection({ ...reply, inspection: { ...inspection, writeAdmission: { allowed: true } } }, "host", "candidate")).toThrow("cannot authorize");
  expect(() => parseNativeImportInspection({ ...reply, inspection: { ...inspection, issues: new Array(1) } }, "host", "candidate")).toThrow();
  const parsed = parseNativeImportInspection(reply, "host", "candidate"); parsed.inspection.issues.push("later");
  expect(inspection.issues).toEqual(["Original cwd is unavailable"]);
});
