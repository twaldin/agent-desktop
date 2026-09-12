import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DockPanel, type DockAddAction } from "../../apps/desktop/src/renderer/DockPanel";
import { createDockState, type DockDestination, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import "../../apps/desktop/src/renderer/theme.css";
import "../../apps/desktop/src/renderer/dock-panel.css";

const tabs: DockTab[] = ["One", "Two", "Three"].flatMap((title, index) => (["right", "bottom"] as const).map(destination => ({ id: `${destination}-${index}`, title, kind: "file", hostId: "home", target: "project:fixture", filePath: `${title}.ts` })));
const selected: Array<{ id: string; destination: DockDestination; menuPresent: boolean }> = [];
function Fixture() {
  const [state, setState] = useState(() => { const value = createDockState(); value.right = { tabIds: ["right-0", "right-1", "right-2"], activeTabId: "right-0", open: true }; value.bottom = { tabIds: ["bottom-0", "bottom-1", "bottom-2"], activeTabId: "bottom-0", open: true }; return value; });
  const actions: DockAddAction[] = ["Files", "Review", "Browser"].map((label, index) => ({ id: label.toLowerCase(), label, icon: index === 0 ? "folder" : index === 1 ? "compose" : "globe", deferSelectionUntilDropdownClose: label === "Files", onSelect: destination => selected.push({ id: label, destination, menuPresent: [...document.querySelectorAll('[role="menu"]')].some(visible) }) }));
  return <main><button id="outside">Outside</button><div className="fixture"><DockPanel destination="right" state={state} tabs={tabs} viewport={{ width: 1100, height: 700, left: 0, top: 0 }} onChange={setState} addActions={actions} renderTab={tab => <div>{tab.title}</div>}/><DockPanel destination="bottom" state={state} tabs={tabs} viewport={{ width: 1100, height: 700, left: 0, top: 0 }} onChange={setState} addActions={actions} renderTab={tab => <div>{tab.title}</div>}/></div></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
const visible = (element: Element | null) => Boolean(element && (element as HTMLElement).getClientRects().length);
Object.assign(window, {
  dockMenuState: () => ({ selected: [...selected], active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim(), menus: [...document.querySelectorAll('[role="menu"]')].filter(visible).map(menu => { const box = (menu as HTMLElement).getBoundingClientRect(); const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]; const focused = items.find(item => item === document.activeElement || item.hasAttribute("data-highlighted"))?.textContent?.trim(); return { destination: menu.getAttribute("data-menu-destination"), items: items.map(item => item.textContent?.trim()), focused, box: { left: box.left, right: box.right, width: box.width, top: box.top, bottom: box.bottom } }; }) }),
  dockMenuTarget: (selector: string) => { const element = document.querySelector<HTMLElement>(selector); if (!element) throw new Error(`Missing ${selector}`); const box = element.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; },
});
