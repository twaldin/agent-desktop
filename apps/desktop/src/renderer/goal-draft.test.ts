import { expect, test } from 'bun:test';
import { GoalDraftStore, goalEditDirty, type GoalEdit } from './goal-draft';

function cache() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const edit = (): GoalEdit => ({ objective: 'Unsent new objective', budget: '4000', fingerprint: 'a'.repeat(64),
  base: { id: 'goal-a', objective: 'Original goal', status: 'active', enabled: true, mode: 'active',
    tokensUsed: 4, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 } });

test('a fresh editor restores exact unsent content and original conflict base, isolated by window/host/session', () => {
  const storage = cache(), original = edit();
  new GoalDraftStore('window-a', 'host-a', 'session-a', storage).write(original);
  const restored = new GoalDraftStore('window-a', 'host-a', 'session-a', storage).read();
  expect(restored).toEqual(original); expect(goalEditDirty(restored!)).toBe(true);
  original.base!.objective = 'Changed caller memory';
  expect(restored!.base!.objective).toBe('Original goal');
  for (const [window, host, session] of [['window-b', 'host-a', 'session-a'], ['window-a', 'host-b', 'session-a'], ['window-a', 'host-a', 'session-b']]) {
    expect(new GoalDraftStore(window!, host!, session!, storage).read()).toBeUndefined();
  }
  expect(storage.values.size).toBe(1);
});

test('acknowledgment from a closed editor clears only its exact draft, preserving reopened edits', () => {
  const storage = cache(), old = new GoalDraftStore('w', 'h', 's', storage), first = edit();
  old.write(first);
  const reopened = new GoalDraftStore('w', 'h', 's', storage), newer = { ...reopened.read()!, objective: 'Newer unsent text' };
  reopened.write(newer); old.discard(first);
  expect(new GoalDraftStore('w', 'h', 's', storage).read()).toEqual(newer);
  reopened.discard(newer); expect(storage.values.size).toBe(0);
});

test('empty authored objective and invalid budget text remain recoverable without being submitted', () => {
  const storage = cache(), store = new GoalDraftStore('w', 'h', 's', storage);
  const value = { ...edit(), objective: '', budget: '-10' }; store.write(value);
  expect(store.read()).toEqual(value); expect(goalEditDirty(store.read()!)).toBe(true);
});

test('malformed, oversized and foreign records stay untouched with a visible recovery warning', () => {
  for (const raw of ['{broken', 'x'.repeat(160_001), JSON.stringify({ version: 1, owner: 'foreign', edit: edit() })]) {
    const storage = cache(), store = new GoalDraftStore('w', 'h', 's', storage); storage.setItem(store.key, raw);
    expect(store.read()).toBeUndefined(); expect(store.warning).toContain('could not be read'); expect(storage.getItem(store.key)).toBe(raw);
  }
});

test('failed writes and clearing are reported instead of claiming local persistence', () => {
  const storage = cache(), store = new GoalDraftStore('w', 'h', 's', { ...storage,
    setItem() { throw new Error('Quota exceeded'); }, removeItem() { throw new Error('Unavailable'); } });
  store.write(edit()); expect(store.warning).toContain('Keep this tab open'); expect(storage.values.size).toBe(0);
  const clearing = new GoalDraftStore('w', 'h', 's', { ...storage, removeItem() { throw new Error('Unavailable'); } });
  clearing.write(edit()); clearing.discard(edit());
  expect(clearing.warning).toContain('could not be cleared'); expect(storage.values.size).toBe(1);
});

test('revert or confirmed save clears an earlier cached revision after a newer write failed', () => {
  const storage = cache(); let fail = false;
  const store = new GoalDraftStore('w', 'h', 's', { ...storage, setItem(key, value) {
    if (fail) throw new Error('Quota exceeded'); storage.setItem(key, value);
  } });
  const first = edit(), newer = { ...first, objective: 'Newer memory-only edit' };
  store.write(first); fail = true; store.write(newer);
  expect(store.warning).toContain('Keep this tab open');
  fail = false; store.discard(newer);
  expect(new GoalDraftStore('w', 'h', 's', storage).read()).toBeUndefined();
  expect(store.warning).toBeUndefined();
});

test('an earlier completion cannot clear newer same-editor content', () => {
  const storage = cache(), store = new GoalDraftStore('w', 'h', 's', storage), first = edit();
  const newer = { ...first, objective: 'Another authored objective' };
  store.write(first); store.write(newer); store.discard(first);
  expect(new GoalDraftStore('w', 'h', 's', storage).read()).toEqual(newer);
});
