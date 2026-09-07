import { createRoot } from "react-dom/client";
import type { TranscriptMessage } from "../../packages/shared/src/protocol";
import { TranscriptMessages } from "../../apps/desktop/src/renderer/Transcript";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const messages = await fetch("../native-messages.json").then(async response => {
  if (!response.ok) throw new Error(`Could not load recorded native history (${response.status})`);
  return response.json() as Promise<TranscriptMessage[]>;
});
const launch = await fetch("../launch.json").then(async response => {
  if (!response.ok) throw new Error(`Could not load acceptance expectations (${response.status})`);
  return response.json() as Promise<{ expected: { userMessageId: string; userNativeId: string; contextEntryId: string; bindingEntryId: string; submissionId: string; label: string; attachments: { id: string; text: string }[] } }>;
});
const expected = launch.expected;
if (!expected?.bindingEntryId || !expected.attachments?.length) throw new Error("Acceptance launch data has no selected-text expectations.");
const errors: string[] = [];
window.addEventListener("error", event => errors.push(String(event.error?.stack ?? event.message)));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason?.stack ?? event.reason)));

document.documentElement.dataset.theme = "dark";
const style = document.createElement("style");
style.textContent = `html,body,#root{min-height:100%;margin:0}.selected-text-history-fixture{box-sizing:border-box;min-height:100vh;padding:48px max(24px,calc((100vw - 736px)/2));background:var(--background);color:var(--text)}.selected-text-history-fixture>.transcript{width:min(736px,100%);margin:0 auto}`;
document.head.append(style);

function Fixture() { return <main className="selected-text-history-fixture"><section className="transcript" aria-label="Recorded native transcript"><TranscriptMessages messages={messages} contextKey="actual-native-selected-text-history" connected={false}/></section></main>; }
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  target(selector: string) { const node = [...document.querySelectorAll<HTMLElement>(selector)].find(item => item.getClientRects().length); if (!node) throw new Error(`Missing ${selector}`); const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; },
  state() {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().toJSON();
    const user = document.querySelector<HTMLElement>(".user-message.has-selected-text");
    const chip = user?.querySelector<HTMLElement>(".composer-selected-text-chip");
    const preview = document.querySelector<HTMLElement>(".composer-selected-text-preview");
    const transcript = document.querySelector<HTMLElement>(".transcript");
    const styles = (node: HTMLElement | null) => node ? (() => { const style = getComputedStyle(node); return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color, backgroundColor: style.backgroundColor }; })() : null;
    return { expected, user: user ? { messageId: user.dataset.messageId, nativeId: user.dataset.nativeId } : null, userAttachment: { buttons: user ? [...user.querySelectorAll("button")].map(button => ({ text: button.textContent?.trim(), ariaLabel: button.getAttribute("aria-label") })) : [], links: user ? user.querySelectorAll("a").length : 0, chipText: chip?.textContent?.trim() ?? null, previewText: preview?.textContent?.trim() ?? null }, preview: rect(".composer-selected-text-preview"), chip: rect(".transcript-user-attachments .composer-selected-text"), errors, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, theme: document.documentElement.dataset.theme, computed: { chip: styles(chip ?? null), transcript: styles(transcript) } };
  },
});
