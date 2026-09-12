import { RRule } from 'rrule';
import type { AutomationInput } from '../../../../packages/shared/src/automations';

export type ScheduleMode = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
export interface ScheduleForm { mode: ScheduleMode; every: number; intervalUnit: 'hours' | 'minutes'; time: string; weekdays: number[]; monthDay: number; raw: string }
export const defaultSchedule = (): ScheduleForm => ({ mode: 'daily', every: 1, intervalUnit: 'hours', time: '09:00', weekdays: [6, 0, 1, 2, 3, 4, 5], monthDay: 1, raw: '' });

export function scheduleRule(form: ScheduleForm): string {
  if (form.mode === 'custom') return form.raw.trim();
  if (!Number.isSafeInteger(form.every) || form.every < 1) throw new Error('Choose a positive repeat interval.');
  if (form.mode === 'hourly') return new RRule({ freq: form.intervalUnit === 'minutes' ? RRule.MINUTELY : RRule.HOURLY, interval: form.every,
    ...(form.intervalUnit === 'minutes' ? {} : { byminute: 0, byweekday: [6, 0, 1, 2, 3, 4, 5] }) }).toString();
  if (!/^\d{2}:\d{2}$/.test(form.time)) throw new Error('Choose a time.');
  const [hour, minute] = form.time.split(':').map(Number);
  if (hour! > 23 || minute! > 59) throw new Error('Choose a valid time.');
  const days = form.mode === 'weekdays' ? [0, 1, 2, 3, 4] : form.mode === 'daily' ? [6, 0, 1, 2, 3, 4, 5] : form.weekdays;
  if (form.mode === 'weekly' && (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error('Choose at least one weekday.');
  if (form.mode === 'monthly' && (!Number.isInteger(form.monthDay) || form.monthDay < 1 || form.monthDay > 31)) throw new Error('Choose a day from 1 to 31.');
  return new RRule({ freq: form.mode === 'monthly' ? RRule.MONTHLY : RRule.WEEKLY,
    byhour: hour, byminute: minute, ...(form.mode === 'monthly' ? { bymonthday: form.monthDay } : { byweekday: days }) }).toString();
}

/** Preserve custom/complex and explicit date rules until the user deliberately edits them. */
export function readSchedule(rrule: string): ScheduleForm {
  const result = { ...defaultSchedule(), mode: 'custom' as ScheduleMode, raw: rrule };
  try {
    if (/\n|DTSTART|UNTIL|COUNT|TZID|BYSETPOS|RDATE|EXRULE|EXDATE/.test(rrule)) return result;
    const options = RRule.parseString(rrule);
    const keys = Object.keys(options);
    const allowed = ['freq', 'interval', 'byhour', 'byminute', 'byweekday', 'bymonthday'];
    if (keys.some(key => !allowed.includes(key))) return result;
    const single = (value: number | number[] | null | undefined, fallback: number) => value == null ? fallback : Array.isArray(value) ? value.length === 1 ? value[0]! : NaN : value;
    const hour = single(options.byhour, 9), minute = single(options.byminute, 0);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return result;
    result.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (options.freq === RRule.HOURLY || options.freq === RRule.MINUTELY) {
      if (options.byhour || options.bymonthday) return result;
      if (options.freq === RRule.MINUTELY && (options.byminute || options.byweekday)) return result;
      if (options.freq === RRule.HOURLY && minute !== 0) return result;
      const days = options.byweekday;
      if (days && (!Array.isArray(days) || days.length !== 7)) return result;
      return { ...result, mode: 'hourly', every: options.interval ?? 1, intervalUnit: options.freq === RRule.MINUTELY ? 'minutes' : 'hours' };
    }
    if ((options.interval ?? 1) !== 1) return result;
    if (options.freq === RRule.DAILY && !options.byweekday && !options.bymonthday) return { ...result, mode: 'daily' };
    if (options.freq === RRule.MONTHLY && options.bymonthday && !options.byweekday) {
      const monthDay = single(options.bymonthday, 1);
      if (Number.isFinite(monthDay) && monthDay >= 1 && monthDay <= 31) return { ...result, mode: 'monthly', monthDay };
    }
    if (options.freq === RRule.WEEKLY && !options.bymonthday) {
      const rawDays = options.byweekday == null ? [] : Array.isArray(options.byweekday) ? options.byweekday : [options.byweekday];
      if (rawDays.some(day => typeof day !== 'number' && (typeof day === 'string' || day.n != null))) return result;
      const days = rawDays.map(day => typeof day === 'number' ? day : typeof day === 'string' ? -1 : day.weekday);
      if (!days.length || new Set(days).size !== days.length) return result;
      return { ...result, mode: days.length === 7 ? 'daily' : days.join(',') === '0,1,2,3,4' ? 'weekdays' : 'weekly', weekdays: days };
    }
  } catch { /* The editor keeps the original rule visible for repair. */ }
  return result;
}

export function newAutomationInput(): AutomationInput {
  return { name: '', prompt: '', status: 'active', notificationPolicy: 'all', rrule: scheduleRule(defaultSchedule()),
    destination: { kind: 'heartbeat-new', projectId: null, execution: { type: 'local' }, environment: null, model: null, thinkingLevel: null, approvalMode: null } };
}

export function automationStatus(task: { status: string; nextRunAt: number | null; lastRunAt: number | null }) {
  return task.status === 'active' && task.nextRunAt === null && task.lastRunAt !== null ? 'completed' : task.status;
}
