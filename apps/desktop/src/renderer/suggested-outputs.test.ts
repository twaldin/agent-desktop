import { expect, test } from 'bun:test';
import { SuggestedOutputs, type SuggestedOutputOwner } from './suggested-outputs';
import type { SessionOutputs } from '@agent-desktop/shared';
const digest = 'a'.repeat(64);
const snapshot = (): SessionOutputs => ({ epoch: 'original', revision: digest, truncated: false, warnings: [], outputs: [{ kind: 'file', path: '/task/report.pdf', entryId: 'entry', turnId: 'turn', label: 'report.pdf', revision: digest }] });
const gate = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
test('held old owner inspection cannot publish after disconnect/return or a task change', async () => {
  const held = gate<SessionOutputs>(), outputs = new SuggestedOutputs(() => {});
  const owner: SuggestedOutputOwner = { hostId: 'host', sessionId: 'session', connected: true, active: true, entryIds: ['entry'], bridge: { getSessionOutputs: () => held.promise } };
  outputs.observe(owner); const read = outputs.read(); outputs.observe({ ...owner, connected: false }); outputs.observe(owner);
  held.resolve(snapshot()); await read; expect(outputs.snapshot).toBeUndefined();
  await outputs.read(); expect(outputs.snapshot?.outputs).toHaveLength(1);
  outputs.observe({ ...owner, sessionId: 'replacement' }); expect(outputs.snapshot).toBeUndefined();
});
test('queued original callback checks entry, connection, lifetime and output revision while read errors retain disabled history', async () => {
  let value = snapshot(), reject = false;
  const outputs = new SuggestedOutputs(() => {}), owner: SuggestedOutputOwner = { hostId: 'host', sessionId: 'session', connected: true, active: true, entryIds: ['entry'], bridge: { getSessionOutputs: async () => { if (reject) throw new Error('offline read'); return value; } } };
  outputs.observe(owner); await outputs.read(); const original = outputs.capture(outputs.snapshot!.outputs[0]!); expect(original?.()).toBe(true);
  value = { ...snapshot(), outputs: [{ ...snapshot().outputs[0]!, revision: 'b'.repeat(64) }] }; await outputs.read(); expect(original?.()).toBe(false);
  const changed = outputs.capture(outputs.snapshot!.outputs[0]!); reject = true; await outputs.read(); expect(outputs.error).toBe('offline read'); expect(changed?.()).toBe(true);
  outputs.observe({ ...owner, connected: false }); expect(changed?.()).toBe(false); expect(outputs.snapshot?.outputs).toHaveLength(1);
  outputs.observe(owner); expect(changed?.()).toBe(false);
  outputs.observe({ ...owner, entryIds: [] }); expect(outputs.snapshot?.outputs).toEqual([]);
});
test('lost source and StrictMode disposal never revive captured admission or retained guards', async () => {
  const outputs = new SuggestedOutputs(() => {}), owner = { hostId: 'owner', sessionId: 'session', connected: true, active: true, entryIds: ['entry'], bridge: { getSessionOutputs: async () => snapshot() } };
  outputs.observe(owner); await outputs.read();
  const row = outputs.snapshot!.outputs[0]!, click = outputs.capture(row)!, retained = outputs.capture(row, true)!;
  outputs.observe({ ...owner, entryIds: [] }); outputs.observe(owner); await outputs.read();
  expect(click()).toBe(false); expect(retained()).toBe(false);
  const next = outputs.capture(outputs.snapshot!.outputs[0]!, true)!;
  outputs.dispose(); outputs.start(); outputs.observe(owner); await outputs.read(); expect(next()).toBe(false);
  let failed = true;
  outputs.observe({ ...owner, bridge: { getSessionOutputs: async () => { if (failed) throw new Error('Original read failed'); return snapshot(); } } });
  await outputs.read(); expect(outputs.error).toBe('Original read failed'); expect(await outputs.admit(row)).toBeUndefined();
  failed = false; await outputs.read(); expect((await outputs.admit(outputs.snapshot!.outputs[0]!))?.()).toBe(true);
});
