import { createRoot } from "react-dom/client";
import type { TranscriptMessage } from "../../packages/shared/src/protocol";
import type { WorkspaceQueryResult } from "../../packages/shared/src/workspace-protocol";
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
const errors: string[] = [];
const calls: Array<{ kind: "dock" | "host" | "save"; path: string; targetId?: string }> = [];
const queries: string[] = [];
let rejectNextOpen = false, rejectNextHost = false, rejectQueries = 0;
window.addEventListener("error", event => errors.push(String(event.error?.stack ?? event.message)));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason?.stack ?? event.reason)));
document.documentElement.dataset.theme = "dark";
const style = document.createElement("style");
style.textContent = `html,body,#root{min-height:100%;margin:0}.file-mentions-fixture{box-sizing:border-box;min-height:100vh;padding:48px max(24px,calc((100vw - 736px)/2));background:var(--background);color:var(--text)}.file-mentions-fixture>.transcript{width:min(736px,100%);margin:0 auto}`;
document.head.append(style);
const actions = {
  cwd: launch.controlledOwnerCwd,
  ownerKey: "controlled-owner",
  fileOpenOptions: async (file: { path: string }): Promise<Extract<WorkspaceQueryResult, { type: "file.open-options" }>> => {
    queries.push(file.path);
    if (rejectQueries > 0) { rejectQueries--; throw new Error("Controlled application discovery refusal"); }
    return { type: "file.open-options", path: file.path, preferredTargetId: "vscode", targets: [
      { id: "vscode", label: "VS Code", kind: "editor" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
      { id: "fileManager", label: "Finder", kind: "file-manager" },
    ] };
  },
  openFile: async (file: { path: string }) => { calls.push({ kind: "dock", path: file.path }); if (rejectNextOpen) { rejectNextOpen = false; throw new Error("Controlled file-open refusal"); } },
  openFileOnHost: async (file: { path: string }, targetId?: string) => { calls.push({ kind: "host", path: file.path, targetId }); if (rejectNextHost) { rejectNextHost = false; throw new Error("Controlled owner application refusal"); } },
  saveFileCopy: async (file: { path: string }) => { calls.push({ kind: "save", path: file.path }); },
};
function Fixture() { return <main className="file-mentions-fixture"><section className="transcript" aria-label="Recorded native transcript"><TranscriptMessages messages={recordedMessages} contextKey="actual-native-file-mentions" connected={false} linkActions={actions}/></section></main>; }
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  target(selector: string, index = 0) { const node = [...document.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length)[index]; if (!node) throw new Error(`Missing ${selector}[${index}]`); const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; },
  rejectNextOpen() { rejectNextOpen = true; },
  rejectNextHost() { rejectNextHost = true; },
  rejectQueries(count = 1) { rejectQueries = count; },
  state() {
    const mention = document.querySelector<HTMLElement>(".transcript-file-mentions");
    const refs = [...document.querySelectorAll<HTMLElement>(".transcript-file-reference")];
    const bodies = [...document.querySelectorAll<HTMLElement>(".transcript-file-snapshot-body")];
    const styles = (node: HTMLElement | null) => node ? (() => { const style = getComputedStyle(node); return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color, backgroundColor: style.backgroundColor }; })() : null;
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]');
    return { expected: launch.expected, message: mention ? { messageId: mention.dataset.messageId, nativeId: mention.dataset.nativeId } : null, refs: refs.map(ref => ({ text: ref.textContent?.trim(), title: ref.getAttribute("title"), tag: ref.tagName, disabled: ref.classList.contains("unavailable") })), bodies: bodies.map(body => body.textContent), errors, calls, queries, menu: menu ? { text: menu.textContent?.replace(/\s+/g, " ").trim(), focused: document.activeElement?.textContent?.trim() } : null, activeIsReference: document.activeElement?.classList.contains("transcript-file-reference") ?? false, platformModifier: /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "meta" : "control", viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, theme: document.documentElement.dataset.theme, computed: { reference: styles(refs[0] ?? null), transcript: styles(document.querySelector<HTMLElement>(".transcript")) } };
  },
});
