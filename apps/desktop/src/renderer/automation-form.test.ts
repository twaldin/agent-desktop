import { expect, test } from 'bun:test';
import { RRule } from 'rrule';
import { defaultSchedule, newAutomationInput, readSchedule, scheduleRule } from './automation-form';

test('manual creation defaults to one new continuing chat and a daily 09:00 host-local rule', () => {
  const input=newAutomationInput(); expect(input.destination).toMatchObject({kind:'heartbeat-new',model:null,projectId:null,execution:{type:'local'}});
  const rule=new RRule({...RRule.parseString(input.rrule), dtstart:new Date(Date.UTC(2026,8,11,0))});
  expect(rule.after(new Date(Date.UTC(2026,8,11,10)),false)?.toISOString()).toBe('2026-09-12T09:00:00.000Z');
  expect(readSchedule(input.rrule)).toMatchObject({mode:'daily',time:'09:00'});
});

test('every 30 minutes, hourly, weekdays and monthly controls produce the next selected occurrence', () => {
  const base=defaultSchedule(), now=new Date(Date.UTC(2026,8,11,10));
  const cases:[Partial<ReturnType<typeof defaultSchedule>>,string][]=[
    [{mode:'hourly',every:30,intervalUnit:'minutes'},'2026-09-11T10:30:00.000Z'],
    [{mode:'hourly',every:2,intervalUnit:'hours'},'2026-09-11T12:00:00.000Z'],
    [{mode:'weekdays'},'2026-09-14T09:00:00.000Z'],
    [{mode:'monthly',monthDay:31},'2026-10-31T09:00:00.000Z'],
  ];
  for(const [change, expected] of cases) {
    const form={...base,...change}, raw=scheduleRule(form), options=RRule.parseString(raw);
    expect(new RRule({...options,dtstart:new Date(Date.UTC(2026,8,11,0))}).after(now,false)?.toISOString()).toBe(expected);
    expect(readSchedule(raw).mode).toBe(form.mode);
  }
});

test('custom date/timezone, filters and uncommon cadence survive viewing without lossy control translation', () => {
  for(const raw of ['RRULE:FREQ=DAILY;COUNT=1','DTSTART;TZID=America/Los_Angeles:20261101T013000\nRRULE:FREQ=DAILY',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;BYSECOND=30','RRULE:FREQ=MONTHLY;BYMONTHDAY=-1',
    'RRULE:FREQ=HOURLY;BYMINUTE=15','RRULE:FREQ=MINUTELY;BYDAY=MO','RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR']) {
    expect(readSchedule(raw)).toMatchObject({mode:'custom',raw}); expect(scheduleRule(readSchedule(raw))).toBe(raw);
  }
  expect(()=>scheduleRule({...defaultSchedule(),mode:'weekly',weekdays:[]})).toThrow('weekday');
  expect(()=>scheduleRule({...defaultSchedule(),mode:'hourly',every:NaN})).toThrow('positive');
});
