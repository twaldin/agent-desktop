import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DockPanel } from "../../apps/desktop/src/renderer/DockPanel";
import { createDockState, insertDockTab, moveDockTab, type DockState, type DockTab } from "../../apps/desktop/src/renderer/dock-state";
import "../../apps/desktop/src/renderer/styles.css";

const layout = document.createElement("style");
layout.textContent = ".fixture{display:grid!important;grid-template-rows:1fr 1fr!important}.fixture>.dock-panel{height:100%!important}";
document.head.append(layout);
const tabs: DockTab[] = [
  { id: "home:project:demo:files", title: "Files", kind: "files", hostId: "home", target: "project:demo" },
  { id: "home:project:demo:review", title: "Review", kind: "review", hostId: "home", target: "project:demo" },
];
const checks: string[] = [];
const drops: string[] = [];
let latest: DockState;
function Fixture() {
  const [state, setState] = useState(() => insertDockTab(insertDockTab(createDockState(), tabs[0]!, "right"), tabs[1]!, "right"));
  latest = state;
  const drop = (id: string, from: "right" | "bottom", to: "right" | "bottom", index: number) => { drops.push(`${id}:${from}:${to}`); setState(current => moveDockTab(current, id, to, index)); };
  const props = { state, tabs, viewport: { left: 0, width: 1200, height: 800 }, onChange: setState, onTabDrop: drop, renderTab: (tab: DockTab, active: boolean) => <div className="fixture-tab" data-active={active}>{tab.title} buffer</div> };
  return <div className="fixture"><DockPanel destination="right" {...props} onHide={() => checks.push("hide callback")} onMaximize={() => checks.push("maximize callback")} addActions={[{ id: "files", label: "Add files", onSelect: () => checks.push("add action") }]}/><DockPanel destination="bottom" {...props}/></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const wait = async (read: () => unknown, label: string) => { const start = performance.now(); while (performance.now() - start < 5_000) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`Timed out: ${label}`); };
const pointer = (type: string, pointerId: number, clientX: number, clientY: number) => new PointerEvent(type, { pointerId, clientX, clientY, bubbles: true, cancelable: true });

Object.assign(window, {
  dockPanelProgress: () => ({ checks, drops, state: latest }),
  runDockPanelAcceptance: async () => {
    await wait(() => document.querySelectorAll(".dock-pill").length === 2, "dock tabs");
    const files = document.querySelector<HTMLButtonElement>(`[data-dock-tab-id="${tabs[0]!.id}"]`)!;
    const review = document.querySelector<HTMLButtonElement>(`[data-dock-tab-id="${tabs[1]!.id}"]`)!;
    review.click();
    await wait(() => latest.right.activeTabId === tabs[1]!.id, "tab selection");
    assert(document.querySelector<HTMLElement>(".fixture-tab[data-active='false']")?.parentElement?.hidden, "inactive panel hidden");
    checks.push("actual tab panel keeps inactive buffer mounted but hidden/inert");
    review.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await wait(() => latest.right.activeTabId === tabs[0]!.id, "Home selection");
    checks.push("keyboard selection updates controlled dock state");

    const filesPill = files.closest<HTMLElement>(".dock-pill")!;
    filesPill.dispatchEvent(pointer("pointerdown", 12, 100, 40));
    filesPill.dispatchEvent(pointer("pointerup", 12, 100, 500));
    await wait(() => latest.bottom.tabIds.includes(tabs[0]!.id) && !latest.right.tabIds.includes(tabs[0]!.id), "cross dock pointer drop");
    checks.push("pointer drop transfers a tab only on release into the other dock");

    const reviewPill = review.closest<HTMLElement>(".dock-pill")!;
    const beforeCancel = [...latest.right.tabIds];
    reviewPill.dispatchEvent(pointer("pointerdown", 13, 100, 40));
    reviewPill.dispatchEvent(pointer("pointermove", 13, 100, 500));
    reviewPill.dispatchEvent(pointer("pointercancel", 13, 100, 500));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert(JSON.stringify(latest.right.tabIds) === JSON.stringify(beforeCancel) && !latest.bottom.tabIds.includes(tabs[1]!.id), "pointer cancel must preserve dock membership");
    checks.push("pointer cancel leaves dock state unchanged");

    const reviewClose = reviewPill.querySelector<HTMLButtonElement>(".dock-tab-close")!;
    const dropsBeforeClose = drops.length;
    reviewClose.dispatchEvent(pointer("pointerdown", 14, 100, 40));
    reviewClose.click();
    await wait(() => !latest.right.tabIds.includes(tabs[1]!.id), "close tab");
    assert(drops.length === dropsBeforeClose, "close button must not start a drag");
    checks.push("tab close does not produce a pointer transfer");

    const separator = document.querySelector<HTMLElement>(".dock-panel-right .dock-resize")!;
    separator.dispatchEvent(pointer("pointerdown", 9, 850, 40));
    separator.dispatchEvent(pointer("pointermove", 9, 620, 40));
    await wait(() => latest.rightWidthRatio > .45, "translated resize change");
    dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wait(() => latest.rightWidthRatio === .36, "resize escape restore");
    checks.push("pointer resize honors translated bounds and Escape restores the initial controlled state");
    return { passed: true, checks, drops };
  },
  dockPanelGeometry: () => { const panel = document.querySelector<HTMLElement>(".dock-panel")!.getBoundingClientRect(), strip = document.querySelector<HTMLElement>(".dock-strip")!.getBoundingClientRect(); return { panel: { width: panel.width, height: panel.height }, strip: { width: strip.width, height: strip.height }, fitting: panel.width > 0 && panel.height > 0 && strip.width <= panel.width && strip.height === 40 }; },
});
