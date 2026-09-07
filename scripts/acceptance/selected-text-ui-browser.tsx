import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope } from "../../packages/shared/src/protocol";
import type { FileTextSelection } from "../../packages/shared/src/selected-text";
import { PierreSourceEditor } from "../../apps/desktop/src/renderer/PierreSourceEditor";
import { RichMarkdownEditor } from "../../apps/desktop/src/renderer/RichMarkdownEditor";
import { ComposerSelectedText } from "../../apps/desktop/src/renderer/ComposerSelectedText";
import { appendSelectedText } from "../../apps/desktop/src/renderer/selected-text-composer";
import { DraftController } from "../../apps/desktop/src/renderer/drafts";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const params = new URLSearchParams(location.search), endpoint = params.get("endpoint")!, hostId = params.get("hostId")!;
const request = async (route: string, body: unknown) => {
  const response = await fetch(endpoint + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? `HTTP ${response.status}`); return value;
};
const initial = await request("/test/state", {}), files = await request("/test/file", {});
const cache = { read: (key: string) => localStorage.getItem(key), write: (key: string, value: string) => localStorage.setItem(key, value) };
const drafts = new DraftController((envelope: CommandEnvelope) => request("/v6/commands", { ...envelope, owner: hostId }), hostId, cache);
drafts.ingest(initial.draft); drafts.setConnected(true);
const errors: string[] = [];
window.addEventListener("error", event => errors.push(String(event.error?.stack ?? event.message)));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason?.stack ?? event.reason)));
let current = { first: files.first, second: files.second, mode: "source" };
function Fixture() {
  const [, update] = useState(0), [mode, setMode] = useState("source"), [first, setFirst] = useState(files.first), [second, setSecond] = useState(files.second);
  useEffect(() => drafts.subscribe(() => update(value => value + 1)), []);
  current = { first, second, mode };
  const draft = drafts.get("new-conversation").draft;
  const add = (path: string, selection: FileTextSelection) => {
    try { drafts.update(draft.id, { selectedTextAttachments: appendSelectedText(drafts.get(draft.id).draft, { hostId, path }, selection) });
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    } catch (error) { errors.push(String(error)); }
  };
  return <main className="selection-fixture">
    <nav><button onClick={() => setMode("source")}>Source</button><button onClick={() => setMode("markdown")}>Markdown</button><button onClick={() => setMode("readonly")}>Read-only Markdown</button></nav>
    <section role="tabpanel" className="selection-editor">
      {mode === "source" ? <PierreSourceEditor documentKey="first.ts" name="first.ts" label="Edit first.ts" onSave={() => {}} value={first} onChange={setFirst} onAddToChat={selection => add("/remote/project/first.ts", selection)}/>
        : <RichMarkdownEditor key={mode} documentKey={mode} label="Edit Markdown second.md" onSave={() => {}} value={second} onChange={setSecond} readOnly={mode === "readonly"} onAddToChat={selection => add("/remote/project/second.md", selection)}/>}
    </section>
    <section className="selection-composer">
      <ComposerSelectedText attachments={draft.selectedTextAttachments} onRemove={ids => { const remove = new Set(ids); drafts.update(draft.id, { selectedTextAttachments: drafts.get(draft.id).draft.selectedTextAttachments?.filter(item => !remove.has(item.id)) }); }} onFocusComposer={() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()}/>
      <textarea aria-label="Prompt" value={draft.text} onChange={event => drafts.update(draft.id, { text: event.target.value })}/>
      <small>{drafts.get(draft.id).status}</small>
    </section>
  </main>;
}
document.documentElement.dataset.theme = "dark";
const style = document.createElement("style"); style.textContent = `.selection-fixture{height:100vh;display:flex;flex-direction:column;padding:24px 64px;box-sizing:border-box;gap:16px}.selection-fixture nav{display:flex;gap:12px}.selection-editor{height:650px;min-height:0}.selection-editor>.pierre-source-editor-frame,.selection-editor>.rich-markdown-file{height:100%}.selection-composer{position:relative;background:var(--composer-surface);border:1px solid var(--border);border-radius:24px;padding:16px;display:flex;flex-direction:column;gap:8px}.selection-composer textarea{border:0;background:transparent;color:var(--text);resize:none;width:100%;font:inherit}.selection-composer small{color:var(--muted)}`; document.head.append(style);
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, { request, editor() { return document.querySelector("diffs-container")?.shadowRoot?.querySelector('[contenteditable="true"]') ?? document.querySelector(".cm-content"); },
  target(selector: string, label?: string) { const node = [...document.querySelectorAll<HTMLElement>(selector)].filter(item => item.getClientRects().length).find(item => label === undefined || item.textContent?.trim() === label || item.ariaLabel === label); if (!node) throw new Error(`Missing ${selector} ${label}`); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; },
  state() { const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON(); return { ...current, draft: drafts.get("new-conversation"), toolbar: rect(".editor-selection-toolbar"), chip: rect(".composer-selected-text"), preview: rect(".composer-selected-text-preview"), focused: document.activeElement?.getAttribute("aria-label"), errors, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale }, font: getComputedStyle(document.body).font }; }
});
