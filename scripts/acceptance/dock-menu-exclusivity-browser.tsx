import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DockPanel as ProductionDockPanel, type DockAddAction } from "../../apps/desktop/src/renderer/DockPanel";
// @ts-expect-error This fixture alias is supplied by dock-menu-exclusivity.ts.
import { DockPanel as SelectedDockPanel } from "dock-menu-exclusivity-panel";
import { createDockState, type DockDestination, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import "../../apps/desktop/src/renderer/theme.css";
import "../../apps/desktop/src/renderer/dock-panel.css";

const DockPanel: typeof ProductionDockPanel = SelectedDockPanel;

const tabs: DockTab[] = ["One", "Two"].flatMap((title, index) => (["right", "bottom"] as const).map(destination => ({ id: `${destination}-${index}`, title, kind: "file", hostId: "home", target: "project:fixture", filePath: `${title}.ts` })));
const selected: Array<{ id: string; destination: DockDestination }> = [];

function Fixture() {
  const [state, setState] = useState(() => {
    const value = createDockState();
    value.right = { tabIds: ["right-0", "right-1"], activeTabId: "right-0", open: true };
    value.bottom = { tabIds: ["bottom-0", "bottom-1"], activeTabId: "bottom-0", open: true };
    return value;
  });
  const actions: DockAddAction[] = ["Files", "Review"].map((label, index) => ({ id: label.toLowerCase(), label, icon: index ? "compose" : "folder", onSelect: destination => selected.push({ id: label, destination }) }));
  return <main><div className="fixture"><DockPanel destination="right" state={state} tabs={tabs} viewport={{ width: 1100, height: 700 }} onChange={setState} addActions={actions} renderTab={tab => <div>{tab.title}</div>}/><DockPanel destination="bottom" state={state} tabs={tabs} viewport={{ width: 1100, height: 700 }} onChange={setState} addActions={actions} renderTab={tab => <div>{tab.title}</div>}/></div></main>;
}

createRoot(document.getElementById("root")!).render(<Fixture/>);
const visible = (element: Element | null) => Boolean(element && (element as HTMLElement).getClientRects().length);
Object.assign(window, {
  dockExclusivityState: () => ({
    selected: [...selected],
    active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim(),
    menus: [...document.querySelectorAll('[role="menu"]')].filter(visible).map(menu => menu.getAttribute("data-menu-destination")),
    details: Object.fromEntries((["right", "bottom"] as const).map(destination => [destination, Boolean(document.querySelector(`[data-app-shell-tab-strip-controller="${destination}"] details.dock-menu[open]`))])),
  }),
  dockExclusivityTarget: (selector: string) => { const element = document.querySelector<HTMLElement>(selector); if (!element) throw new Error(`Missing ${selector}`); const box = element.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; },
});
