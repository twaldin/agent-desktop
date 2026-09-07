import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DesktopBridge, NativeSkillFileRef } from "@agent-desktop/shared";
import { NativePluginDirectory } from "../../apps/desktop/src/renderer/NativePluginDirectory";
import { useWorkspaceFileClose } from "../../apps/desktop/src/renderer/WorkspaceFileClose";
import { NativeSkillFileController } from "../../apps/desktop/src/renderer/native-skill-file-state";
import { NativeSkillFilePanel } from "../../apps/desktop/src/renderer/NativeSkillFilePanel";
import { offlineCache } from "../../apps/desktop/src/renderer/offline-cache";
import { useWorkbenchDock } from "../../apps/desktop/src/renderer/use-workbench-dock";
import { DockPanel } from "../../apps/desktop/src/renderer/DockPanel";
import { defaultWindowView, type WindowViewState } from "../../apps/desktop/src/window-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const params = new URLSearchParams(location.search);
const endpoint = params.get("endpoint")!;
const target = JSON.parse(params.get("target")!);
const hostId = params.get("hostId")!;
const request = async (route: string, body: unknown) => {
  const response = await fetch(endpoint + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error((value as any).error?.message ?? `Skill file request failed (${response.status})`);
  return value as any;
};
const listeners = new Set<(event: any) => void>();
setInterval(() => void request("/test/events", {}).then(events => { for (const event of events) for (const listener of listeners) listener(event); }).catch(() => {}), 100);
const runtimeErrors: string[] = [];
const keyboardEvents: {key:string;role:string|null;label:string|null}[]=[];
addEventListener("keydown",event=>keyboardEvents.push({key:event.key,role:(event.target as HTMLElement)?.getAttribute("role"),label:(event.target as HTMLElement)?.getAttribute("aria-label")}));
addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));
const bridge = {
  acquireSkillImage: window.agentDesktop.acquireSkillImage,
  releaseWorkspaceImage: window.agentDesktop.releaseWorkspaceImage,
  openExternal: async () => { throw new Error("External open is unavailable in this renderer fixture."); },
  command: (envelope, owner) => request("/v5/commands", { ...envelope, owner }),
  getPlugins: (value, owner) => request("/v1/integrations/plugins/read", { target: value, owner }),
  getMarketplaceCatalog: (value, owner) => request("/v1/integrations/acquisition/catalog", { target: value, owner }),
  getComposerActions: (value, refresh, owner) => request("/v1/composer/actions", { target: value, refresh, owner }),
  getSkillInventory: (value, refresh, owner) => request("/v1/composer/skill-inventory", { target: value, refresh, owner }),
  getSettings: (value, owner) => request("/v1/settings/read", { target: value, owner }),
  setSetting: (mutation, value, owner) => request("/v1/settings/mutate", { mutation, target: value, owner }),
  getSkillDetail: (value, skillId, catalogRevision, owner, inventory) => request("/v1/composer/skill-detail", { target: value, skillId, catalogRevision, inventory, owner }),
  getSkillFile: (ref, owner) => request("/v1/composer/skill-file", { ref, owner }),
  subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
} satisfies Partial<DesktopBridge> as DesktopBridge;

let restoredView:WindowViewState|null=null;
let windowWrites:Promise<unknown>=Promise.resolve();
let dockProjection:()=>unknown=()=>null;
let flushFiles:()=>Promise<void>=async()=>{};
let setConnection: (value: boolean) => void;
let recreateControllers: () => void;
let controllerProjection: () => unknown[] = () => [];
function Fixture() {
  const [connected, setConnected] = useState(sessionStorage.getItem("skill-fixture-offline")!=="true");
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState("");
  setConnection = setConnected;
  recreateControllers = () => setGeneration(value => value + 1);
  const initial = useMemo(() => restoredView??defaultWindowView(), []);
  const dock = useWorkbenchDock(bridge, initial, hostId, target, connected, setError);
  dockProjection=()=>dock.snapshot;
  useEffect(()=>{
    if(dock.persisted){const view={...defaultWindowView(),dock:dock.persisted};windowWrites=windowWrites.then(()=>request("/test/window-view",{action:"save",view}));}
  },[dock.persisted]);
  const controllers = useMemo(() => new Map<string, NativeSkillFileController>(), [generation]);
  const fileClose=useWorkspaceFileClose(()=>undefined,tab=>controllers.get(tab.id));
  useEffect(()=>{const live=new Set(dock.snapshot.tabs.map(tab=>tab.id));for(const [id,controller] of controllers)if(!live.has(id)){controller.dispose();controllers.delete(id);}},[controllers,dock.snapshot.tabs]);
  flushFiles=async()=>{await Promise.all([...controllers.values()].map(controller=>controller.flush()));};
  controllerProjection = () => [...controllers.entries()].map(([id, controller]) => ({ id, ...controller.state, file: controller.state.file ? {
    revision: controller.state.file.document.revision, text: controller.state.file.document.text,
  } : null, pending: Boolean((controller as any).pending) }));
  useEffect(() => () => { for (const controller of controllers.values()) controller.dispose(); controllers.clear(); }, [controllers]);
  const renderTab = (tab: any, active: boolean) => {
    if (tab.kind !== "skill-file" || !tab.skillFile) return null;
    let controller = controllers.get(tab.id);
    if (!controller) { controller = new NativeSkillFileController(bridge, tab.hostId, tab.skillFile, offlineCache,tab.fileMode); controllers.set(tab.id, controller); }
    return <NativeSkillFilePanel controller={controller} fileMode={tab.fileMode??"markdown"} onFileModeChange={mode=>dock.setFileMode(tab.id,mode)} fileScroll={tab.fileScroll} onFileScrollChange={(mode,top)=>dock.setFileScroll(tab.id,mode,top)} connected={connected} active={active}/>;
  };
  return <main className="app-shell skill-file-fixture">
    <section className="skill-file-directory"><NativePluginDirectory bridge={bridge} hostId={hostId} hostName="Disposable native host" connected={connected}
      target={target} initialTab="skills" onOpenSkillFile={dock.openSkillFile} onManage={()=>{}} onMarketplace={()=>{}} onClose={()=>{}}/></section>
    {dock.snapshot.state.right.open && <DockPanel onBeforeClose={fileClose.onBeforeClose} destination="right" state={dock.snapshot.state} tabs={dock.snapshot.tabs}
      viewport={{ width: innerWidth, height: innerHeight, left: 0, top: 0, rightMinWidth: 360 }} onChange={dock.change} renderTab={renderTab}/>}
    {fileClose.dialog}
    {error && <p role="alert">{error}</p>}
  </main>;
}
document.documentElement.dataset.theme = "dark";
void request("/test/window-view",{action:"read"}).then(view=>{restoredView=view;createRoot(document.getElementById("root")!).render(<Fixture/>);});
Object.assign(window, {
  request,
  editor(selector:string) { return document.querySelector<HTMLElement>(selector) ?? [...document.querySelectorAll("diffs-container")].map(node=>node.shadowRoot?.querySelector<HTMLElement>(selector)).find(Boolean); },
  connection: (value: boolean) => {sessionStorage.setItem("skill-fixture-offline",String(!value));setConnection(value);},
  flushWindow:()=>windowWrites,
  flushFiles:()=>flushFiles(),
  recreateControllers: () => recreateControllers(),
  target(selector: string, label?: string) { const item = [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length).find(node => label === undefined || node.textContent?.trim() === label); if (!item) throw new Error(`Missing ${selector} ${label ?? ""}`); item.scrollIntoView({ block: "center" }); const box = item.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; },
  state() { return { dock:dockProjection(), body: document.body.innerText, width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    menuGeometry: (() => {
      const node = document.querySelector<HTMLElement>('.skill-dialog-menu');
      if (!node) return null;
      const style = getComputedStyle(node);
      return { trigger: document.querySelector('[aria-label="More actions"][aria-haspopup="menu"]')?.getBoundingClientRect().toJSON(), bounds: node.getBoundingClientRect().toJSON(), font: style.font, padding: style.padding,
        borderRadius: style.borderRadius, shadow: style.boxShadow, background: style.backgroundColor,
        focusedRole: document.activeElement?.getAttribute('role'), focusedText: document.activeElement?.textContent?.trim(),
        rows: [...node.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => {
          const itemStyle = getComputedStyle(item);
          return { bounds: item.getBoundingClientRect().toJSON(), font: itemStyle.font, padding: itemStyle.padding,
            borderRadius: itemStyle.borderRadius, background: itemStyle.backgroundColor };
        }) };
    })(),
    menu: [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(node => ({ text: node.textContent?.trim(), disabled: (node as HTMLButtonElement).disabled, icons: node.querySelectorAll("svg,img").length })),
    source: (controllerProjection()[0] as any)?.text,
    richText: document.querySelector(".cm-content")?.textContent,
    richLines: [...document.querySelectorAll<HTMLElement>(".cm-line")].map(node=>({text:node.textContent,className:node.className,font:getComputedStyle(node).font,bounds:node.getBoundingClientRect().toJSON()})),
    sourceInputs: [...document.querySelectorAll("diffs-container")].flatMap(node=>[...(node.shadowRoot?.querySelectorAll<HTMLElement>("[contenteditable]") ?? [])].map(input=>({text:input.textContent,label:input.getAttribute("aria-label"),font:getComputedStyle(input).font,bounds:input.getBoundingClientRect().toJSON()}))),
    sourceDom: [...document.querySelectorAll("diffs-container")].map(node=>node.shadowRoot?.textContent),
    dockTabs: [...document.querySelectorAll<HTMLElement>("[data-dock-tab-id]")].map(node => node.textContent?.trim()),
    controllers: controllerProjection(),
    runtimeErrors: [...runtimeErrors], keyboardEvents:[...keyboardEvents],
  }; },
});
