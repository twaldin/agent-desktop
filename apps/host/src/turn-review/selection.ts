/** Recorded and derived candidates stay separate: pinned 7982 pyr has asymmetric priorities. */
export interface TurnCandidates<T> {
  turnId: string | null;
  recorded: T | null;
  derived: T | null;
}
export interface SelectedTurnCandidate<T> { turnId: string | null; source: "recorded" | "derived"; value: T }
/** Callers admit nonempty candidates before selection; filtering afterward must not select an older turn again. */
export function selectLastTurn<T>(turns: readonly TurnCandidates<T>[]): SelectedTurnCandidate<T> | null {
  const last = turns.at(-1);
  if (!last) return null;
  if (last.recorded !== null) return { turnId: last.turnId, source: "recorded", value: last.recorded };
  let recorded: SelectedTurnCandidate<T> | null = null;
  let derived: SelectedTurnCandidate<T> | null = null;
  let lastDerived: SelectedTurnCandidate<T> | null = null;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (recorded === null && turn.recorded !== null) recorded = { turnId: turn.turnId, source: "recorded", value: turn.recorded };
    if (derived === null) {
      if (turn.derived !== null) derived = { turnId: turn.turnId, source: "derived", value: turn.derived };
      if (index === turns.length - 1) lastDerived = derived;
    }
    if (recorded !== null && derived !== null) break;
  }
  if (recorded !== null && recorded.turnId === last.turnId) return recorded;
  if (lastDerived !== null) return lastDerived;
  if (derived !== null && derived.turnId !== last.turnId) return recorded !== null && recorded.turnId === derived.turnId ? recorded : derived;
  return recorded;
}
