import { createRoot } from 'react-dom/client';
import { GoalPanel } from '../../apps/desktop/src/renderer/GoalPanel';
import type { DesktopBridge, GoalMutationRequest, SessionActivitySnapshot } from '../../packages/shared/src/protocol';
import '../../apps/desktop/src/renderer/styles.css';

const root = createRoot(document.getElementById('root')!);
const checks: string[] = [], requests: GoalMutationRequest[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function wait(predicate: () => unknown, message: string) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await sleep(20); }
  throw new Error(`Timed out: ${message}`);
}
function snapshot(hostId = 'host-a', sessionId = 'session-a', objective = 'Original native goal', fingerprint = 'a'.repeat(64)): SessionActivitySnapshot {
  return { protocolVersion: 1, hostId, sessionId,
    goal: { availability: 'available', value: { id: 'goal-a', objective, status: 'active', enabled: true, mode: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 } },
    goalControlTicket: { controlEpoch: 'current-epoch', observedAt: Date.now(), goalFingerprint: fingerprint },
    jobs: { availability: 'unavailable', reason: 'Fixture' }, agents: { availability: 'unavailable', reason: 'Fixture' }, sources: { availability: 'unavailable', reason: 'Fixture' } };
}
let outcome: 'completed' | 'unknown' = 'unknown';
let held: (() => void) | undefined, hold = false;
const bridge = {
  subscribe() { return () => {}; },
  async mutateGoal(sessionId: string, request: GoalMutationRequest, hostId?: string) {
    requests.push(request);
    if (hold) await new Promise<void>(resolve => { held = resolve; });
    return { protocolVersion: 1, sessionId, hostId, requestId: request.requestId, outcome,
      ...(outcome === 'completed' ? { goal: null } : { message: 'Acknowledgment lost; inspect the original host goal.' }) };
  },
} as DesktopBridge;
function render(value = snapshot(), windowId = 'window-a', connected = true) {
  root.render(<GoalPanel bridge={bridge} hostId={value.hostId} sessionId={value.sessionId} draftWindowId={windowId}
    connected={connected} running={false} archived={false} active activity={{ owner: `${value.hostId}:${value.sessionId}`, value, refresh() {} }}/>);
}
const textarea = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Goal"]')!;
function input(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
async function close() { root.render(null); await wait(() => !textarea(), 'closed editor'); }
async function reopened(value = snapshot(), windowId = 'window-a', connected = true) {
  render(value, windowId, connected); await wait(() => textarea(), 'reopened editor');
}
function click(selector: string) { document.querySelector<HTMLButtonElement>(selector)!.click(); }
Object.assign(window, {
  goalDraftProgress: () => ({ checks, requests, text: document.body.innerText }),
  async goalDraftRun(phase: 'write' | 'restore') {
    if (phase === 'write') {
      localStorage.clear(); await reopened();
      input('[aria-label="Goal"]', 'Retain unsent goal across desktop restart');
      input('[aria-label="Goal token budget"]', '4200'); await sleep(30);
      await close(); await reopened();
      assert(textarea().value === 'Retain unsent goal across desktop restart', 'tab close lost objective');
      assert(document.querySelector<HTMLInputElement>('[aria-label="Goal token budget"]')!.value === '4200', 'tab close lost budget');
      checks.push('Tab close/reopen restores unsent objective and budget');
      await close(); await reopened(snapshot('host-b'));
      assert(textarea().value === 'Original native goal', 'host switch leaked draft');
      await close(); await reopened(snapshot('host-a', 'session-b'));
      assert(textarea().value === 'Original native goal', 'session switch leaked draft');
      await close(); await reopened(snapshot(), 'window-b');
      assert(textarea().value === 'Original native goal', 'second window leaked draft');
      checks.push('Host, conversation and restored-window identities isolate drafts');
      await close(); await reopened(snapshot(), 'window-a', false);
      assert(textarea().value === 'Retain unsent goal across desktop restart', 'offline reopen lost edits');
      assert(document.querySelector<HTMLButtonElement>('.goal-save')!.disabled, 'offline save was enabled');
      assert(requests.length === 0, 'restore dispatched a mutation');
      checks.push('Offline restore remains editable and never submits automatically');
    } else {
      await reopened(snapshot('host-a', 'session-a', 'Remote changed goal', 'b'.repeat(64)));
      assert(textarea().value === 'Retain unsent goal across desktop restart', 'process restart lost draft');
      assert(document.querySelector<HTMLInputElement>('[aria-label="Goal token budget"]')!.value === '4200', 'process restart lost budget');
      assert(requests.length === 0, 'restart auto-submitted');
      checks.push('A new Electron process restores disk-backed edits without rebasing to remote changes');
      click('.goal-save'); await wait(() => requests.length === 1 && document.body.innerText.includes('Acknowledgment lost'), 'unknown save');
      assert(requests[0]!.goalFingerprint === 'a'.repeat(64), 'restored draft lost original conflict fingerprint');
      assert(requests[0]!.controlEpoch === 'current-epoch', 'save reused a persisted ticket');
      await close(); await reopened();
      assert(textarea().value === 'Retain unsent goal across desktop restart', 'unknown save erased draft');
      checks.push('Unknown save retains edits; explicit save uses fresh ticket with original base fingerprint');
      click('[aria-label="Revert goal edits"]'); await sleep(30); await close(); await reopened();
      assert(textarea().value === 'Original native goal', 'explicit revert did not clear draft');
      input('[aria-label="Goal"]', 'Pending save text'); await sleep(30);
      outcome = 'completed'; hold = true; click('.goal-save'); await wait(() => held && textarea().readOnly, 'held save');
      await close(); await reopened(); input('[aria-label="Goal"]', 'Newer reopened editor text'); await sleep(30);
      held!(); await sleep(50); await close(); await reopened();
      assert(textarea().value === 'Newer reopened editor text', 'old completed save erased newer edits');
      checks.push('Late completion from a closed editor preserves newer reopened edits');
      hold = false; click('.goal-save'); await wait(() => document.querySelector('.goal-panel')?.getAttribute('aria-busy') === 'false', 'successful save');
      await close(); await reopened(); assert(textarea().value === 'Original native goal', 'successful save retained submitted draft');
      checks.push('Only confirmed completion or explicit revert clears the exact draft');
      input('[aria-label="Goal"]', 'Recoverable unsent goal'); await sleep(30);
    }
    return { passed: true, phase, checks, requests: requests.length, qualification: 'Actual React and isolated Electron localStorage; controlled native goal bridge, synthetic DOM input, no provider or reference UI.' };
  },
});
