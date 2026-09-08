import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CommandEnvelope, DesktopBridge, DesktopEvent, WorkspaceQuery, WorkspaceTarget } from "../../packages/shared/src/protocol";
import type { WholeFileAttachment } from "../../packages/shared/src/whole-file";
import { ComposerEditor, type ComposerEditorHandle } from "../../apps/desktop/src/renderer/ComposerEditor";
import { WorkspacePanel } from "../../apps/desktop/src/renderer/WorkspacePanel";
import { offlineCache } from "../../apps/desktop/src/renderer/offline-cache";
import { wholeFileOpenTarget } from "../../apps/desktop/src/renderer/whole-file-composer";
import { WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!;
const hostId = params.get("hostId")!;
const filePath = params.get("filePath")!;
const fileName = params.get("fileName")!;
const routeKey = "standalone-file-acceptance:route";
const connectionKey = "standalone-file-acceptance:connected";
const request = async (route: string, body: unknown) => {
  const response = await fetch(endpoint + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error((value as any).error?.message ?? (value as any).error ?? `Request failed (${response.status})`);
  return value as any;
};
const listeners = new Set<(event: DesktopEvent) => void>();
setInterval(() => void request("/test/events", {}).then(events => { for (const event of events) for (const listener of listeners) listener(event); }).catch(() => {}), 100);
const bridge = {
  workspaceQuery: (owner: WorkspaceTarget, query: WorkspaceQuery, selectedHost?: string) => request("/v1/workspace/query", { target: owner, query, owner: selectedHost }),
  command: (envelope: CommandEnvelope, selectedHost?: string) => request("/v1/commands", { ...envelope, owner: selectedHost }),
  subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
} satisfies Pick<DesktopBridge, "workspaceQuery" | "command" | "subscribe">;

const attachment: WholeFileAttachment = { id: "standalone-pointer", source: { kind: "file", hostId, path: filePath } };
const runtimeErrors: string[] = [];
const activations: unknown[] = [];
window.addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));
let setConnection: (connected: boolean) => void;
let recreateState: () => void;
let current: WorkspaceState | undefined;

function StandalonePanel({ openedPath, connected, generation }: { openedPath: string; connected: boolean; generation: number }) {
  const name = openedPath.split("/").at(-1)!;
  const parent = openedPath.slice(0, openedPath.lastIndexOf("/"));
  const target: WorkspaceTarget = { filePath: openedPath };
  const data = useMemo(() => new WorkspaceState(bridge, hostId, target, offlineCache, hostId), [openedPath, generation]);
  current = data;
  useEffect(() => () => data.stop(), [data]);
  return <WorkspacePanel embedded data={data} connected={connected} active filePath={name} name={name} path={parent} tab="files" onClose={() => {}} onOpenProject={async () => {}}/>;
}

function Fixture() {
  const [connected, changeConnection] = useState(() => localStorage.getItem(connectionKey) !== "false");
  const [openedPath, setOpenedPath] = useState<string | undefined>(() => localStorage.getItem(routeKey) ?? undefined);
  const [generation, setGeneration] = useState(0);
  const [composer, setComposer] = useState({ text: "", files: [attachment] as WholeFileAttachment[] });
  const composerRef = useRef<ComposerEditorHandle>(null);
  setConnection = value => { localStorage.setItem(connectionKey, String(value)); changeConnection(value); };
  recreateState = () => setGeneration(value => value + 1);
  return <main className="standalone-file-fixture">
    {openedPath && <StandalonePanel openedPath={openedPath} connected={connected} generation={generation}/>}
    <section className="standalone-composer" aria-label="Standalone file composer">
      <ComposerEditor inputRef={composerRef} scope="standalone-file-acceptance" text={composer.text} files={composer.files} placeholder="Ask anything"
        onChange={setComposer} onOpenFile={source => {
          const opened = wholeFileOpenTarget(source, hostId);
          activations.push({ source, opened });
          if ("absolutePath" in opened) { localStorage.setItem(routeKey, opened.absolutePath); setOpenedPath(opened.absolutePath); }
        }}/>
    </section>
  </main>;
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
Object.assign(window, {
  request,
  connection: (value: boolean) => setConnection(value),
  recreateState: () => recreateState(),
  editor() {
    return [...document.querySelectorAll("diffs-container")].flatMap(node => [...(node.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])]).find(node => node.getClientRects().length);
  },
  target(selector: string) {
    const node = [...document.querySelectorAll<HTMLElement>(selector)].find(item => item.getClientRects().length);
    if (!node) throw new Error(`Missing ${selector}`);
    const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  },
  state() {
    const documentState = current?.documents.get(fileName);
    const panel = document.querySelector<HTMLElement>(".workspace-panel");
    return {
      body: document.body.innerText,
      restored: current?.restored,
      connected: current?.connected,
      opened: current?.opened,
      standalonePath: current?.standalonePath,
      mountedTarget: current?.target,
      text: documentState?.text,
      dirty: documentState?.dirty,
      saveError: documentState?.saveError,
      errors: current?.errors ?? {},
      pending: current?.pending,
      busy: current?.busy,
      activations: [...activations],
      runtimeErrors: [...runtimeErrors],
      ui: {
        panelLabel: panel?.ariaLabel,
        directoryBrowser: Boolean(document.querySelector(".file-browser")),
        fileTree: Boolean(document.querySelector(".workspace-file-tree-pane,.file-tree-toggle")),
        workspaceTabs: Boolean(document.querySelector(".workspace-tabs")),
        review: Boolean(document.querySelector(".review-panel")),
      },
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale },
    };
  },
});
