import { describe, expect, test } from "bun:test";
import { assertSessionProcessesResultMatches, parseSessionProcessReceipt, parseSessionProcessesEnvelope,
  parseSessionProcessesRequest, parseSessionProcessesSnapshot, SESSION_PROCESSES_MAX_INPUT_CHARS, SESSION_PROCESSES_MAX_ROWS,
  type SessionProcessRow } from "./session-processes";

const owner = { nativeSessionId: "session", epoch: "loaded-worker", projectDir: "/project" };
const target = { brokerId: "broker", name: "server", id: "record", generation: 3 };
const row: SessionProcessRow = { target, state: "ready", pid: 42, createdAt: 10, startedAt: 12, readyAt: 14, restartCount: 0,
  outputBytes: 100, nativeOwner: "other-session", readyPending: [], persist: true, detached: false };
const snapshot = { owner, brokerId: target.brokerId, rows: [row] };
const input = { action: "input" as const, operationId: "operation-1", owner, target, text: "hello\n" };
const receipt = { action: "input" as const, operationId: input.operationId, owner, target, status: "completed" as const, row };

describe("native process wire boundary", () => {
  test("clones each original owner, target and readiness array without removing another session's project row", () => {
    const source = structuredClone(snapshot), parsed = parseSessionProcessesSnapshot(source);
    source.owner.epoch = "replacement"; source.rows[0]!.target.generation++; source.rows[0]!.readyPending.push("port");
    expect(parsed).toEqual(snapshot);
    parsed.rows[0]!.nativeOwner = "edited";
    expect(source.rows[0]!.nativeOwner).toBe("other-session");
    expect(parseSessionProcessesRequest(input)).toEqual(input);
  });
  test("refuses sparse rows/readiness, duplicate names, foreign broker rows and over-cap lists", () => {
    for (const rows of [new Array(1), [row, row], [{ ...row, target: { ...target, brokerId: "foreign" } }],
      [{ ...row, state: "starting", readyPending: new Array(1) }], Array(SESSION_PROCESSES_MAX_ROWS + 1).fill(row)]) {
      expect(() => parseSessionProcessesSnapshot({ ...snapshot, rows })).toThrow();
    }
    expect(parseSessionProcessesSnapshot({ ...snapshot, rows: [] }).rows).toEqual([]);
  });
  test("does not admit environment/command leakage, aliases or global native operations", () => {
    expect(() => parseSessionProcessesSnapshot({ ...snapshot, rows: [{ ...row, env: { secret: "private" } }] })).toThrow();
    expect(() => parseSessionProcessesRequest({ ...input, name: "different" })).toThrow();
    for (const action of ["shutdown", "start", "send", "describe"]) expect(() => parseSessionProcessesRequest({ ...input, action })).toThrow();
    for (const extra of [{ text: "input" }, { target }, { operationId: input.operationId }]) {
      expect(() => parseSessionProcessesRequest({ action: "read", ...extra })).toThrow();
    }
  });
  test("retains exact bounded input bytes and rejects empty or oversized input", () => {
    const text = "\u0003abc\r\n";
    expect(parseSessionProcessesRequest({ ...input, text })).toEqual({ ...input, text });
    expect(() => parseSessionProcessesRequest({ ...input, text: "" })).toThrow();
    expect(() => parseSessionProcessesRequest({ ...input, text: "x".repeat(SESSION_PROCESSES_MAX_INPUT_CHARS + 1) })).toThrow();
    expect(() => parseSessionProcessesRequest({ ...input, action: "stop" })).toThrow();
    expect(() => parseSessionProcessesRequest({ ...input, operationId: "../../escape" })).toThrow();
  });
  test("only a restart receipt advances the original generation, exactly once", () => {
    expect(parseSessionProcessReceipt(receipt)).toEqual(receipt);
    const restarted = { ...receipt, action: "restart" as const, row: { ...row, target: { ...target, generation: target.generation + 1 } } };
    expect(parseSessionProcessReceipt(restarted)).toEqual(restarted);
    for (const bad of [receipt, restarted]) {
      expect(() => parseSessionProcessReceipt({ ...bad, row: { ...bad.row, target: { ...bad.row.target, id: "replacement" } } })).toThrow();
      expect(() => parseSessionProcessReceipt({ ...bad, row: { ...bad.row, target: { ...bad.row.target, generation: bad.row.target.generation + 1 } } })).toThrow();
    }
    for (const status of ["pending", "unknown", "rejected"]) expect(() => parseSessionProcessReceipt({ ...receipt, status })).toThrow();
    expect(parseSessionProcessReceipt({ action: "input", operationId: input.operationId, owner, target, status: "unknown" }).status).toBe("unknown");
  });
  test("matches request, receipt and envelope through host/session/epoch/project/process identity", () => {
    const result = { action: "mutation" as const, receipt };
    assertSessionProcessesResultMatches(input, result);
    for (const changed of [{ operationId: "operation-2" }, { action: "stop" as const }, { owner: { ...owner, epoch: "replacement" } },
      { owner: { ...owner, projectDir: "/other" } }, { target: { ...target, generation: 4 } }]) {
      expect(() => assertSessionProcessesResultMatches(input, { ...result, receipt: { ...receipt, ...changed } })).toThrow();
    }
    const envelope = { protocolVersion: 1 as const, hostId: "host", sessionId: owner.nativeSessionId, result };
    expect(parseSessionProcessesEnvelope(envelope, "host", "session")).toEqual(envelope);
    expect(() => parseSessionProcessesEnvelope(envelope, "other", "session")).toThrow();
    expect(() => parseSessionProcessesEnvelope(envelope, "host", "other")).toThrow();
    expect(() => parseSessionProcessesEnvelope({ ...envelope, result: { action: "read", snapshot: { ...snapshot, owner: { ...owner, nativeSessionId: "other" } } } }, "host", "session")).toThrow();
  });
  test("receipt absence stays distinct from a successful operation or a foreign receipt", () => {
    const request = { action: "receipt" as const, operationId: input.operationId };
    assertSessionProcessesResultMatches(request, { action: "receipt", receipt: null });
    expect(() => assertSessionProcessesResultMatches(request, { action: "receipt", receipt: { ...receipt, operationId: "other-id" } })).toThrow();
    expect(() => assertSessionProcessesResultMatches(input, { action: "receipt", receipt })).toThrow();
    const log = { action: "logs" as const, owner, target, text: "READY\n", truncated: false };
    assertSessionProcessesResultMatches({ action: "logs", owner, target }, log);
    expect(() => assertSessionProcessesResultMatches({ action: "logs", owner, target: { ...target, brokerId: "restarted" } }, log)).toThrow();
  });
});
