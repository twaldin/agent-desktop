import { createRoot } from "react-dom/client";
import { useCallback, useMemo, useState } from "react";
import type { WorkspaceQuery, WorkspaceQueryResult } from "../../packages/shared/src/workspace-protocol";
import { WorkspaceFileSearch } from "../../apps/desktop/src/renderer/WorkspaceFileSearch";

type Pending = { id: number; owner: string; query: string; resolve(value: WorkspaceQueryResult): void; reject(error: Error): void };
const pending: Pending[] = [], opened: string[] = [];
let next = 1;

function Fixture() {
  const [open, setOpen] = useState(true), [connected, setConnected] = useState(true), [owner, setOwner] = useState("owner-a"), [render, setRender] = useState(0);
  const query = useCallback((request: WorkspaceQuery): Promise<WorkspaceQueryResult> => {
    if (request.type !== "files.search") return Promise.reject(new Error("Unexpected fixture query"));
    return new Promise((resolve, reject) => pending.push({ id: next++, owner, query: request.query, resolve, reject }));
  }, [owner]);
  const data = useMemo(() => ({ query }), [query]);
  const close = () => setOpen(false);
  return <main data-render={render}>
    <button id="file-search-trigger" onClick={() => setOpen(true)}>Open file search</button>
    <button id="fixture-render" onClick={() => setRender(value => value + 1)}>Ordinary redraw</button>
    {open && <WorkspaceFileSearch data={data} connected={connected} onClose={close} onOpenFile={path => opened.push(path)}/>} 
    <output id="fixture-owner">{owner}</output>
    <output id="fixture-connected">{String(connected)}</output>
    <button id="fixture-owner-a" onClick={() => setOwner("owner-a")}>Owner A</button>
    <button id="fixture-owner-b" onClick={() => setOwner("owner-b")}>Owner B</button>
    <button id="fixture-connect" onClick={() => setConnected(true)}>Connect</button>
    <button id="fixture-disconnect" onClick={() => setConnected(false)}>Disconnect</button>
  </main>;
}

const result = (paths: string[]): Extract<WorkspaceQueryResult, { type: "files.search" }> => ({
  type: "files.search", entries: paths.map((path, index) => ({ path, name: path.split("/").at(-1)!, kind: "file", size: 1, modifiedAt: 0, mode: 0o600, score: 100 - index })), nativeTotalMatches: paths.length, status: "complete",
});
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  fileSearchState: () => ({ open: Boolean(document.querySelector('[role="dialog"]')), activeId: (document.activeElement as HTMLElement | null)?.id, activeRole: document.activeElement?.getAttribute("role"),
    input: (document.querySelector("input") as HTMLInputElement | null)?.value, text: document.body.innerText, opened: [...opened], pending: pending.map(value => ({ id: value.id, owner: value.owner, query: value.query })),
    options: [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(option => ({ text: option.textContent?.trim(), selected: option.getAttribute("aria-selected") })), owner: document.querySelector("#fixture-owner")?.textContent, connected: document.querySelector("#fixture-connected")?.textContent }),
  fileSearchResolve: (id: number, paths: string[]) => { const index = pending.findIndex(value => value.id === id); if (index < 0) throw new Error(`No pending request ${id}`); pending.splice(index, 1)[0]!.resolve(result(paths)); },
  fileSearchReject: (id: number, message = "Controlled failure") => { const index = pending.findIndex(value => value.id === id); if (index < 0) throw new Error(`No pending request ${id}`); pending.splice(index, 1)[0]!.reject(new Error(message)); },
  fileSearchControl: (id: string) => (document.getElementById(id) as HTMLButtonElement | null)?.click(),
  fileSearchTarget: (selector: string) => { const element = document.querySelector<HTMLElement>(selector); if (!element) throw new Error(`Missing ${selector}`); const box = element.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; },
  fileSearchCompose: (type: "compositionstart" | "compositionend") => document.querySelector("input")?.dispatchEvent(new CompositionEvent(type, { bubbles: true })),
});
