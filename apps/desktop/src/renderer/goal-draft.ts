import { parseNativeGoalActivity } from '../../../../packages/shared/src/goal-control';
import type { NativeGoalActivity, SessionActivitySnapshot } from '../../../../packages/shared/src/protocol';

export interface GoalEdit { objective: string; budget: string; base: NativeGoalActivity | null; fingerprint: string }
export function goalEditFrom(snapshot: SessionActivitySnapshot): GoalEdit | undefined {
  if (snapshot.goal.availability !== 'available' || !snapshot.goalControlTicket) return;
  const goal = snapshot.goal.value;
  return { objective: goal?.objective ?? '', budget: goal?.tokenBudget?.toString() ?? '', base: goal, fingerprint: snapshot.goalControlTicket.goalFingerprint };
}
export function goalEditDirty(edit: GoalEdit): boolean {
  return edit.objective !== (edit.base?.objective ?? '') || edit.budget !== (edit.base?.tokenBudget?.toString() ?? '');
}

/** Unsent editor content, scoped to one restored window and original host/session.
 * The saved base is a conflict guard, never a ticket authorizing a host mutation. */
export class GoalDraftStore {
  readonly key: string;
  warning?: string;
  private current?: string;
  private saved?: string;
  constructor(windowId: string, hostId: string, sessionId: string, private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
    this.key = `agent-desktop:goal-draft:v1:${JSON.stringify([windowId, hostId, sessionId])}`;
  }
  private encode(edit: GoalEdit): string { return JSON.stringify({ version: 1, owner: this.key, edit: { objective: edit.objective, budget: edit.budget, fingerprint: edit.fingerprint, base: edit.base === null ? null : parseNativeGoalActivity(edit.base) } }); }
  read(): GoalEdit | undefined {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return;
      if (raw.length > 160_000) throw new Error('Oversized draft');
      const value = JSON.parse(raw);
      const edit = value?.edit;
      if (value?.version !== 1 || value.owner !== this.key || !edit || typeof edit.objective !== 'string'
        || edit.objective.length > 16_384 || edit.objective.includes('\0') || typeof edit.budget !== 'string'
        || edit.budget.length > 128 || typeof edit.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(edit.fingerprint)) throw new Error('Invalid draft');
      const result = { objective: edit.objective, budget: edit.budget, fingerprint: edit.fingerprint,
        base: edit.base === null ? null : parseNativeGoalActivity(edit.base) };
      this.current = this.encode(result); this.saved = raw;
      return result;
    } catch {
      this.warning = 'Saved goal edits could not be read. The stored copy was kept; review the host goal before replacing it.';
    }
  }
  write(edit: GoalEdit): void {
    this.current = this.encode(edit);
    try { this.storage.setItem(this.key, this.current); this.saved = this.current; this.warning = undefined; }
    catch { this.warning = 'Goal edits could not be stored on this device. Keep this tab open until you save them on the host.'; }
  }
  discard(edit: GoalEdit): void {
    try {
      // Remove only this editor's last successful write. A failed newer write
      // still owns that older cached revision; another editor's write does not.
      if (this.current !== this.encode(edit)) return;
      const stored = this.storage.getItem(this.key);
      if (this.saved !== undefined && stored === this.saved) this.storage.removeItem(this.key);
      else if (stored !== null) {
        this.warning = 'Different goal edits are stored for this window. They were kept and may appear when you reopen the editor.';
        return;
      }
      this.current = undefined; this.saved = undefined; this.warning = undefined;
    } catch { this.warning = 'The saved draft could not be cleared. It may reappear when this goal editor is reopened.'; }
  }
}
