import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { SessionForkState } from './session-fork-state';
import { startForkFixture } from '../../../../scripts/acceptance/session-fork-app/fixture';

// These boundaries use the composed production host/worker and native OMP journals; worker55 was the historical Work baseline.
// Only delivery timing is controlled; no fork response or native copy is mocked.
test('read-only recovery and a late reply never repeat or resurrect a bound fork', async () => {
  const fixture = await startForkFixture();
  try {
    const { bridge, connection, context } = fixture;
    const saved = new Map<string, string>(), cache = { read: (key: string) => saved.get(key) ?? null, write: (key: string, value: string) => { saved.set(key, value); } };
    const before = await bridge.getState(connection.hostId), original = await readFile(context.sourceFile);
    const sourceDraft = before.drafts.find(draft => draft.id === `session:${context.sourceId}`);
    let calls = 0;
    const dropped = { ...bridge, command: async (...args: Parameters<typeof bridge.command>) => {
      calls++; const result = await bridge.command(...args); expect(result.ok).toBe(true);
      throw new Error('Acknowledgement lost after the real host completed Fork.');
    } };
    const first = new SessionForkState(dropped, connection.hostId, context.sourceId, cache);
    first.setConnection(true, true); await first.refresh(); await first.start({ type: 'local' });
    expect(first.canStart).toBe(false); expect(first.canResume).toBe(false);
    const restored = new SessionForkState(bridge, connection.hostId, context.sourceId, cache);
    restored.setConnection(true, true); await restored.refresh();
    const child = restored.child!;
    expect(child.id).not.toBe(context.sourceId);
    const bound = await bridge.getState(connection.hostId);
    expect(bound.sessions.map(session => session.id).sort()).toEqual([...before.sessions.map(session => session.id), child.id].sort());
    expect(bound.drafts.find(draft => draft.id === `session:${child.id}`)?.text).toBe('');
    expect(bound.drafts.find(draft => draft.id === `session:${context.sourceId}`)).toEqual(sourceDraft);
    expect(await readFile(context.sourceFile)).toEqual(original);
    const childDraft = bound.drafts.find(draft => draft.id === `session:${child.id}`)!;
    const edited = await fixture.command({ type: 'draft.put', expectedRevision: childDraft.revision,
      draft: { id: childDraft.id, projectId: childDraft.projectId, model: null, text: 'Later child draft must survive receipt navigation' } });
    expect(edited.ok).toBe(true);
    expect(restored.takeChild()?.id).toBe(child.id);
    await restored.refresh(); expect(restored.takeChild()).toBeUndefined();
    expect((await bridge.getState(connection.hostId)).drafts.find(draft => draft.id === childDraft.id)?.text).toBe('Later child draft must survive receipt navigation');
    expect(calls).toBe(1);

    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), completed = new Promise<void>(resolve => { observed = resolve; });
    const held = { ...bridge, command: async (...args: Parameters<typeof bridge.command>) => {
      calls++; const result = await bridge.command(...args); expect(result.ok).toBe(true); observed(); await gate; return result;
    } };
    const next = new SessionForkState(held, connection.hostId, context.sourceId, cache);
    next.setConnection(true, true); await next.refresh(); const sending = next.start({ type: 'local' });
    let secondId: string;
    try {
      await Promise.race([completed, sending.then(() => { throw new Error(next.error ?? 'The real fork did not reach its delivery barrier.'); })]);
      await next.refresh(); const second = next.takeChild();
      if (!second) throw new Error(next.error ?? 'The real fork binding was not available.');
      secondId = second.id; expect(secondId).not.toBe(child.id);
    } finally { release(); await sending; }
    expect(next.takeChild()).toBeUndefined();
    expect(calls).toBe(2);
    const after = await bridge.getState(connection.hostId);
    expect(after.sessions.map(session => session.id).sort()).toEqual([...before.sessions.map(session => session.id), child.id, secondId].sort());
    expect(after.drafts.find(draft => draft.id === `session:${context.sourceId}`)).toEqual(sourceDraft);
  } finally { await fixture.stop(); }
}, 120_000);

test('disconnected generations, foreign snapshots and corrupt saved owners cannot authorize Fork', async () => {
  const fixture = await startForkFixture();
  try {
    const { bridge, connection, context } = fixture;
    const saved = new Map<string, string>(), cache = { read: (key: string) => saved.get(key) ?? null, write: (key: string, value: string) => { saved.set(key, value); } };
    const before = await bridge.getState(connection.hostId);
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { observed = resolve; });
    const held = { ...bridge, getSessionFork: async (...args: Parameters<NonNullable<typeof bridge.getSessionFork>>) => {
      const value = await bridge.getSessionFork!(...args); observed(); await gate; return value;
    } };
    const data = new SessionForkState(held, connection.hostId, context.sourceId, cache);
    data.setConnection(true, true); const pending = data.refresh();
    try {
      await Promise.race([reading, pending.then(() => { throw new Error(data.error ?? 'The real snapshot did not reach its delivery barrier.'); })]);
      data.setConnection(false, true); data.setConnection(true, true);
    } finally { release(); await pending; }
    expect(data.canStart).toBe(false); await data.start({ type: 'local' });
    const foreign = new SessionForkState({ ...bridge, getSessionFork: () => bridge.getSessionFork!(context.standaloneId, connection.hostId) }, connection.hostId, context.sourceId, cache);
    foreign.setConnection(true, true); await foreign.refresh(); expect(foreign.canStart).toBe(false); await foreign.start({ type: 'local' });
    saved.set(`session-fork.pending.${connection.hostId}.${context.sourceId}`, JSON.stringify({ operationId: 'unconfirmed', envelope: { id: 'unconfirmed', commandVersion: 16,
      command: { type: 'session.fork', sessionId: context.standaloneId, expectedRevision: 'captured', execution: { type: 'local' } } } }));
    const corrupt = new SessionForkState(bridge, connection.hostId, context.sourceId, cache);
    corrupt.setConnection(true, true); await corrupt.refresh(); await corrupt.start({ type: 'local' });
    expect(corrupt.canStart).toBe(false);
    expect((await bridge.getState(connection.hostId)).sessions.map(session => session.id).sort()).toEqual(before.sessions.map(session => session.id).sort());
  } finally { await fixture.stop(); }
}, 120_000);
