// Reuse the maintained full-App session, dock, terminal, and preference bridge.
import "./app-dock-browser";
import type { CommandEnvelope, CommandResult } from "../../packages/shared/src/protocol";

const bridge = window.agentDesktop;
const baseCommand = bridge.command.bind(bridge);
const baseGetState = bridge.getState.bind(bridge);
type MenuCall = { items: unknown[]; settled: boolean; choice?: string | null; resolve(choice: string | null): void };
const menuCalls: MenuCall[] = [];
const preferenceCommands: CommandEnvelope[] = [];
let holdNextPreference = false;
let preferenceGate: (() => void) | undefined;
let stateUnavailable = false;

bridge.showContextMenu = async (items: any[]) => new Promise<string | null>(resolve => {
  const call: MenuCall = { items: structuredClone(items), settled: false, resolve: choice => { if (call.settled) return; call.settled = true; call.choice = choice; resolve(choice); } };
  menuCalls.push(call);
});
bridge.command = async (envelope: CommandEnvelope, hostId?: string): Promise<CommandResult> => {
  if (envelope.command.type === "preferences.put") {
    preferenceCommands.push(structuredClone(envelope));
    if (holdNextPreference) {
      holdNextPreference = false;
      await new Promise<void>(resolve => { preferenceGate = resolve; });
      preferenceGate = undefined;
    }
  }
  return baseCommand(envelope, hostId);
};
bridge.getState = async (...args) => {
  if (stateUnavailable) throw new Error("Controlled local host offline");
  return baseGetState(...args);
};

const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length);
Object.assign(window, {
  headerPanelMenuState: async () => ({
    text: document.body.innerText,
    menuCalls: menuCalls.map(({ items, settled, choice }) => ({ items, settled, choice })),
    preferenceCommands: structuredClone(preferenceCommands),
    pendingPreference: Boolean(preferenceGate),
    preferences: await bridge.getPreferences(),
    bottomLauncher: Boolean(document.querySelector('.header-panel-actions [aria-label="Toggle bottom panel"]')),
    sideLauncher: Boolean(document.querySelector('.header-panel-actions [aria-label="Toggle side panel"]')),
    bottomSetting: document.querySelector('[role="switch"][aria-label="Bottom panel"]')?.getAttribute("aria-checked") ?? null,
    terminalLocation: document.querySelector('.general-segmented [aria-pressed="true"]')?.textContent?.trim() ?? null,
    settingsOpen: Boolean(document.querySelector(".settings-sidebar")),
    dock: (window as any).appDockProgress().dock,
  }),
  headerPanelMenuControl: (command: string, value?: unknown) => {
    if (command === "resolve-menu") { const call = menuCalls.find(item => !item.settled); if (!call) throw new Error("No pending controlled menu"); call.resolve(value === null ? null : String(value)); return; }
    if (command === "hold-next-preference") { holdNextPreference = true; return; }
    if (command === "release-preference") { if (!preferenceGate) throw new Error("No held preference command"); preferenceGate(); return; }
    if (command === "set-state-unavailable") { stateUnavailable = Boolean(value); return; }
    throw new Error(`Unknown header panel menu fixture command ${command}`);
  },
});

declare global {
  interface Window {
    headerPanelMenuState(): Promise<unknown>;
    headerPanelMenuControl(command: string, value?: unknown): void;
  }
}
