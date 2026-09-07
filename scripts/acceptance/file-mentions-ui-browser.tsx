import { createRoot } from "react-dom/client";
import type { TranscriptMessage } from "../../packages/shared/src/protocol";
import { TranscriptMessages } from "../../apps/desktop/src/renderer/Transcript";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const raw = await fetch("../native-messages.json").then(async response => {
  if (!response.ok) throw new Error(`Could not load recorded native history (${response.status})`);
  return response.json() as Promise<TranscriptMessage[] | { messages?: TranscriptMessage[]; reopened?: TranscriptMessage }>;
});
const messages = Array.isArray(raw) ? raw : raw.messages ?? (raw.reopened ? [raw.reopened] : undefined);
const launch = await fetch("../launch.json").then(async response => {
  if (!response.ok) throw new Error(`Could not load acceptance expectations (${response.status})`);
  return response.json() as Promise<{ controlledOwnerCwd: string; expected: { messageId: string; nativeId: string; files: { path: string; content: string; skippedReason?: string; actionPath?: string }[] } }>;
});
if (!Array.isArray(messages) || !launch.expected.files.length) throw new Error("Acceptance input has no native file mentions.");
const recordedMessages = messages;
const errors: string[] = [], calls: { path: string }[] = [];
let rejectNext = false;
window.addEventListener("error", event => errors.push(String(event.error?.stack ?? event.message)));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason?.stack ?? event.reason)));
document.documentElement.dataset.theme = "dark";
const style = document.createElement("style");
style.textContent = `html,body,#root{min-height:100%;margin:0}.file-mentions-fixture{box-sizing:border-box;min-height:100vh;padding:48px max(24px,calc((100vw - 736px)/2));background:var(--background);color:var(--text)}.file-mentions-fixture>.transcript{width:min(736px,100%);margin:0 auto}`;
document.head.append(style);
const actions = { cwd: launch.controlledOwnerCwd, openFile: async (file: { path: string }) => { calls.push({ path: file.path }); if (rejectNext) { rejectNext = false; throw new Error("Controlled file-open refusal"); } } };
function Fixture() { return <main className="file-mentions-fixture"><section className="transcript" aria-label="Recorded native transcript"><TranscriptMessages messages={recordedMessages} contextKey="actual-native-file-mentions" connected={false} linkActions={actions}/></section></main>; }
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  target(selector: string, index = 0) { const node = [...document.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length)[index]; if (!node) throw new Error(`Missing ${selector}[${index}]`); const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; },
  rejectNextOpen() { rejectNext = true; },
  state() {
    const mention = document.querySelector<HTMLElement>(".transcript-file-mentions");
    const refs = [...document.querySelectorAll<HTMLElement>(".transcript-file-reference")];
    const bodies = [...document.querySelectorAll<HTMLElement>(".transcript-file-snapshot-body")];
    const styles = (node: HTMLElement | null) => node ? (() => { const style = getComputedStyle(node); return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color, backgroundColor: style.backgroundColor }; })() : null;
    return { expected: launch.expected, message: mention ? { messageId: mention.dataset.messageId, nativeId: mention.dataset.nativeId } : null, refs: refs.map(ref => ({ text: ref.textContent?.trim(), title: ref.getAttribute("title"), tag: ref.tagName, disabled: ref.classList.contains("unavailable") })), bodies: bodies.map(body => body.textContent), errors, calls, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, theme: document.documentElement.dataset.theme, computed: { reference: styles(refs[0] ?? null), transcript: styles(document.querySelector<HTMLElement>(".transcript")) } };
  },
});
