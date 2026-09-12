import { describe, expect, test } from "bun:test";
import { nextAutomationRun, parseAutomationSchedule } from "./automation-schedule";

describe("automation recurrence", () => {
  test("rejects invalid and impossible recurrence input", () => {
    expect(() => parseAutomationSchedule("not a rule", 0)).toThrow("invalid");
    expect(() => parseAutomationSchedule("RRULE:FREQ=DAILY;INTERVAL=0", 0)).toThrow("invalid");
  });

  test("computes an exclusive next occurrence and deterministic bounded jitter", () => {
    const at = Date.UTC(2026, 8, 12, 12, 0, 0);
    const rule = "DTSTART:20260912T120000Z\nRRULE:FREQ=DAILY;BYHOUR=13;BYMINUTE=0;BYSECOND=0";
    const first = nextAutomationRun(rule, at, { id: "a", heartbeat: false, jitterSalt: "salt" })!;
    expect(first).toBeGreaterThanOrEqual(Date.UTC(2026, 8, 12, 13, 0, 0));
    expect(first).toBeLessThan(Date.UTC(2026, 8, 12, 13, 2, 0));
    expect(nextAutomationRun(rule, at, { id: "a", heartbeat: false, jitterSalt: "salt" })).toBe(first);
    expect(nextAutomationRun(rule, first, { id: "a", heartbeat: false, jitterSalt: "salt" })).toBeGreaterThan(first);
  });

  test("does not jitter count-one or simple heartbeat intervals", () => {
    const at = Date.UTC(2026, 8, 12, 12, 0, 0);
    const countRule = "DTSTART:20260912T130000Z\nRRULE:FREQ=HOURLY;COUNT=1";
    const countOne = nextAutomationRun(countRule, Date.UTC(2026,8,12,12,59), { id: "one", heartbeat: false, jitterSalt: "salt" });
    expect(countOne).toBe(Date.UTC(2026, 8, 12, 13, 0, 0));
    expect(nextAutomationRun(countRule, Date.UTC(2026,8,12,12,59), { id: "other", heartbeat: false, jitterSalt: "different" })).toBe(countOne);
    const heartbeatRule = "DTSTART:20260912T120000Z\nRRULE:FREQ=MINUTELY;INTERVAL=15";
    const heartbeat = nextAutomationRun(heartbeatRule, at, { id: "heartbeat", heartbeat: true, jitterSalt: "salt" });
    expect(heartbeat).toBe(Date.UTC(2026, 8, 12, 12, 15, 0));
    expect(nextAutomationRun(heartbeatRule, at, { id: "other", heartbeat: true, jitterSalt: "different" })).toBe(heartbeat);
  });

  test("preserves a TZID wall-clock schedule across daylight saving time", () => {
    const rule = "DTSTART;TZID=America/Los_Angeles:20260307T090000\nRRULE:FREQ=DAILY;COUNT=3";
    const next = nextAutomationRun(rule, Date.UTC(2026, 2, 7, 17, 0, 0), {id:"dst",heartbeat:true,jitterSalt:"salt"})!;
    expect(next).toBeGreaterThanOrEqual(Date.UTC(2026, 2, 8, 16, 0, 0));
    expect(next).toBeLessThan(Date.UTC(2026, 2, 8, 16, 2, 0));
  });

  test("skips a nonexistent DST wall time instead of rejecting the scheduler tick",()=>{
    const rule="DTSTART;TZID=America/Los_Angeles:20260307T023000\nRRULE:FREQ=DAILY;COUNT=3";
    const next=nextAutomationRun(rule,Date.UTC(2026,2,7,10,30),{id:"gap",heartbeat:true,jitterSalt:"salt"})!;
    expect(next).toBeGreaterThanOrEqual(Date.UTC(2026,2,9,9,30));expect(next).toBeLessThan(Date.UTC(2026,2,9,9,32));
  });

  test("anchors a rule without DTSTART to the host wall-clock minute",()=>{
    const now=Date.UTC(2026,8,12,12), schedule=parseAutomationSchedule("RRULE:FREQ=HOURLY",now);
    expect(schedule.source).toBe("RRULE:FREQ=HOURLY");
    expect(nextAutomationRun(schedule.source,now,{id:"local",heartbeat:true,jitterSalt:"salt"})).toBe(now+60*60_000);
  });
});
