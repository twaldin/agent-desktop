import { createRoot } from "react-dom/client";
import { useLayoutEffect, useRef, useState } from "react";
import type { DesktopBridge, WorkspaceTarget } from "@agent-desktop/shared";
import { NativePluginDirectory } from "../../apps/desktop/src/renderer/NativePluginDirectory";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const emptyPlugins = { revision: "plugins-1", plugins: [], application: "new-sessions" };
const emptyMarketplaces = { revision: "marketplaces-1", marketplaces: [], installed: [], projectScopeAvailable: true };
const emptyComposer = { protocolVersion: 1, hostId: "menu-host", cwd: "/fixture", revision: "composer-1", skills: [], actions: [], diagnostics: [] };
const bridge = {
  getPlugins: async () => emptyPlugins,
  getMarketplaceCatalog: async () => emptyMarketplaces,
  getComposerActions: async () => emptyComposer,
  subscribe: () => () => {},
} as unknown as DesktopBridge;

let setConnectedFixture: (value: boolean) => void;
let setOwnerFixture: (value: string) => void;

function Fixture() {
  const [connected, setConnected] = useState(true);
  const [owner, setOwner] = useState("project-a");
  const [marketplaceCalls, setMarketplaceCalls] = useState(0);
  const destination = useRef<HTMLInputElement>(null);
  setConnectedFixture = setConnected;
  setOwnerFixture = setOwner;
  useLayoutEffect(() => { if (marketplaceCalls) destination.current?.focus(); }, [marketplaceCalls]);
  const target: WorkspaceTarget = { projectId: owner };
  return <main className="menu-fixture">
    <NativePluginDirectory bridge={bridge} hostId="menu-host" hostName="Menu fixture" connected={connected} target={target}
      onManage={() => {}} onMarketplace={() => setMarketplaceCalls(value => value + 1)} onClose={() => {}} />
    <button className="outside-target">Outside</button>
    <div className="scroll-zone" style={{ position: "fixed", left: 8, bottom: 8, width: 180, height: 42, overflow: "auto" }}><div style={{ height: 240 }}>Scrollable fixture area</div></div>
    {marketplaceCalls > 0 && <input ref={destination} aria-label="Marketplace destination" />}
    <output aria-label="Marketplace callback count">{marketplaceCalls}</output>
  </main>;
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
Object.assign(window, {
  fixtureOwner: (value: string) => setOwnerFixture(value),
  fixtureConnection: (value: boolean) => setConnectedFixture(value),
  fixtureState: () => ({
    active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim(),
    menu: Boolean(document.querySelector(".plugin-directory-add-menu")),
    calls: Number(document.querySelector('output[aria-label="Marketplace callback count"]')?.textContent ?? 0),
    triggerDisabled: (document.querySelector(".plugin-directory-add-trigger") as HTMLButtonElement | null)?.disabled,
  }),
  fixtureTarget(selector: string, text?: string) {
    const element = [...document.querySelectorAll<HTMLElement>(selector)].find(item => item.getClientRects().length && (text === undefined || item.textContent?.trim() === text));
    if (!element) throw new Error(`Missing ${selector} ${text ?? ""}`);
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  },
});
