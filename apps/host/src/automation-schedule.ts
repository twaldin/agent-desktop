import { createHash } from "node:crypto";
import { RRule, RRuleSet, rrulestr } from "rrule";

const JITTER_SECONDS = 120;

function safeIntegerList(value: unknown, minimum: number, maximum: number, allowZero = true): boolean {
  return value === null || value === undefined || Array.isArray(value) && value.every(item =>
    Number.isSafeInteger(item) && item >= minimum && item <= maximum && (allowZero || item !== 0));
}

function validRule(rule: RRule): boolean {
  const options = rule.options;
  return Number.isSafeInteger(options.interval) && options.interval > 0
    && (options.count === null || Number.isSafeInteger(options.count) && options.count > 0)
    && safeIntegerList(options.byhour, 0, 23)
    && safeIntegerList(options.byminute, 0, 59)
    && safeIntegerList(options.bysecond, 0, 60)
    && safeIntegerList(options.byweekday, 0, 6)
    && safeIntegerList(options.bymonth, 1, 12)
    && safeIntegerList(options.bymonthday, 1, 31)
    && safeIntegerList(options.bynmonthday, -31, -1)
    && safeIntegerList(options.byyearday, -366, 366, false)
    && safeIntegerList(options.byweekno, -53, 53, false);
}

export interface ValidAutomationSchedule {
  source: string;
  set: RRuleSet;
  first: RRule | undefined;
  tzid: string | undefined;
}

function timezone(source: string): string | undefined {
  const values = [...source.matchAll(/^(?:DTSTART|RDATE|EXDATE);TZID=([^:;\r\n]+):/gmi)].map(match => match[1]!);
  if (new Set(values).size > 1) throw new Error("The automation recurrence rule uses multiple time zones.");
  const value = values[0];
  if (value) try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); } catch { throw new Error("The automation recurrence time zone is invalid."); }
  return value;
}

function parts(date: Date, tzid: string): number[] {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tzid, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return [values.year, values.month - 1, values.day, values.hour, values.minute, values.second];
}

function instantAsWall(date: Date, tzid: string): Date { return new Date(Date.UTC(...parts(date, tzid) as [number,number,number,number,number,number])); }
function wallAsInstant(date: Date, tzid: string): Date {
  const wall = date.getTime(); let guess = wall;
  for (let attempt = 0; attempt < 3; attempt++) {
    const represented = Date.UTC(...parts(new Date(guess), tzid) as [number,number,number,number,number,number]);
    const next = guess + wall - represented;
    if (next === guess) break; guess = next;
  }
  const result = new Date(guess);
  if (instantAsWall(result, tzid).getTime() !== wall) throw new Error("The automation recurrence falls in a missing or ambiguous local time.");
  return result;
}

/** Parse the same RRuleSet surface as the reference. Invalid or impossible
 * schedules fail at save time instead of leaving an active task inert. */
export function parseAutomationSchedule(source: string, now = Date.now()): ValidAutomationSchedule {
  const trimmed = source.trim();
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const local = parts(new Date(Math.floor(now / 60_000) * 60_000), localZone);
  const localStart = `${String(local[0]).padStart(4,"0")}${String(local[1]!+1).padStart(2,"0")}${String(local[2]).padStart(2,"0")}T${String(local[3]).padStart(2,"0")}${String(local[4]).padStart(2,"0")}00`;
  const anchored = /^DTSTART(?:;|:)/mi.test(trimmed) ? trimmed
    : `DTSTART;TZID=${localZone}:${localStart}\n${trimmed}`;
  const tzid = timezone(anchored);
  const recurrenceSource = tzid ? anchored.replace(/;TZID=[^:;\r\n]+(?=:)/g, "") : anchored;
  let set: RRuleSet;
  try {
    const parsed = rrulestr(recurrenceSource, { forceset: true });
    if (!(parsed instanceof RRuleSet)) throw new Error("not a set");
    set = parsed;
  } catch {
    throw new Error("The automation recurrence rule is invalid.");
  }
  const rules = [...set.rrules(), ...set.exrules()];
  if (!set.rrules().length || !rules.every(validRule)) throw new Error("The automation recurrence rule is invalid.");
  return { source: trimmed, set, first: set.rrules()[0], tzid };
}

function simpleHeartbeatInterval(rule: RRule | undefined): boolean {
  if (!rule) return false;
  const original = rule.origOptions;
  if (rule.options.freq === RRule.MINUTELY) return original.byhour == null && original.byminute == null && original.bysecond == null
    && original.byweekday == null && original.bymonth == null && original.bymonthday == null;
  if (rule.options.freq === RRule.HOURLY) return original.byhour == null && original.bysecond == null
    && (original.byminute == null || Array.isArray(original.byminute) && original.byminute.length === 1 && original.byminute[0] === 0)
    && original.byweekday == null && original.bymonth == null && original.bymonthday == null;
  return false;
}

function jitterEligible(schedule: ValidAutomationSchedule, heartbeat: boolean): boolean {
  const rule = schedule.first;
  if (!rule || rule.options.count === 1 || heartbeat && simpleHeartbeatInterval(rule)) return false;
  return rule.options.freq === RRule.HOURLY || rule.options.freq === RRule.DAILY || rule.options.freq === RRule.WEEKLY;
}

export function nextAutomationRun(source: string, after: number, input: { id: string; heartbeat: boolean; jitterSalt: string }): number | null {
  const schedule = parseAutomationSchedule(source, after);
  let next = schedule.set.after(schedule.tzid ? instantAsWall(new Date(after), schedule.tzid) : new Date(after), false);
  if (!next) return null;
  let resolved: Date | undefined;
  for (let skipped = 0; skipped < 370 && next; skipped++) {
    try { resolved = schedule.tzid ? wallAsInstant(next, schedule.tzid) : next; break; }
    catch { next = schedule.set.after(next, false); }
  }
  if (!resolved) return null;
  let value = resolved.getTime();
  if (jitterEligible(schedule, input.heartbeat)) {
    const seconds = createHash("sha256").update(`${input.jitterSalt}:${input.id}:${value}`).digest().readUInt32BE(0) % JITTER_SECONDS;
    value += seconds * 1000;
  }
  return value;
}
