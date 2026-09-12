// Reuse the full App's existing isolated session/terminal fixture; do not replace App components.
import "./app-dock-browser";
import type { CommandEnvelope } from "../../packages/shared/src/protocol";
const bridge = window.agentDesktop;
if (!bridge.nativeTerminalQuery || !bridge.nativeTerminalAction) throw new Error("Terminal fixture bridge is missing");
const command = bridge.command.bind(bridge), query = bridge.nativeTerminalQuery.bind(bridge), action = bridge.nativeTerminalAction.bind(bridge);
const commands: CommandEnvelope[] = [], terminalQueries: unknown[] = [], terminalActions: unknown[] = [];
bridge.command = async (...args) => { commands.push(structuredClone(args[0])); return command(...args); };
bridge.nativeTerminalQuery = async (...args) => { terminalQueries.push(structuredClone(args)); return query(...args); };
bridge.nativeTerminalAction = async (...args) => { terminalActions.push(structuredClone(args)); return action(...args); };
Object.assign(window,{generalDockState:()=>({
  body:document.body.innerText,
  bottomLauncher:Boolean(document.querySelector('.header-panel-actions [aria-label="Toggle bottom panel"]')),
  location:document.querySelector('.general-segmented')?.textContent,
  selectedLocation:document.querySelector('.general-segmented [aria-pressed=true]')?.textContent,
  bottomPreference:document.querySelector('[role=switch][aria-label="Bottom panel"]')?.getAttribute('aria-checked'),
  tabs:[...document.querySelectorAll<HTMLElement>('[data-dock-tab-id]')].map(tab=>({id:tab.dataset.dockTabId,destination:tab.closest<HTMLElement>('[data-dock-destination]')?.dataset.dockDestination,selected:tab.getAttribute('aria-selected'),text:tab.textContent})),
  commands,terminalQueries,terminalActions,
}),generalDockPreferences:()=>bridge.getPreferences()});
