import { createRoot } from "react-dom/client";
import type { CommandEnvelope, CommandResult, DesktopBridge, DesktopEvent } from "../../packages/shared/src/protocol";
import type { PreferenceRecord, PreferencesSnapshot } from "../../packages/shared/src/preferences";
import { PreferencesState } from "../../apps/desktop/src/renderer/preferences-state";
import { KeepAwakeSettings } from "../../apps/desktop/src/renderer/KeepAwakeSettings";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/connections-settings.css";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void };
const deferred = <T,>(): Deferred<T> => { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
type Status = { supported: boolean; active: boolean; onBattery?: boolean; error?: string };
const hostId = "host-local";
const preferenceActor = "00000000-0000-4000-8000-000000000001";
let records: PreferenceRecord[] = [];
let status: Status = { supported: true, active: false, onBattery: false };
const initialStatus = deferred<Status>();
let nextStatus: Deferred<Status> | undefined = initialStatus, capturedStatus: Deferred<Status> | undefined;
let pendingCommand: { envelope: CommandEnvelope; wait: Deferred<"success" | "failure"> } | undefined;
const statusReads: { supported: boolean; deferred: boolean }[] = [], commands: CommandEnvelope[] = [], cacheWrites: { key: string; value: string }[] = [];
const statusListeners = new Set<() => void>(), desktopListeners = new Set<(event: DesktopEvent) => void>();
const snapshot = (): PreferencesSnapshot => ({ version: 1, records: structuredClone(records) });
const bridge = {
  getPreferences: async () => snapshot(),
  subscribe: (listener: (event: DesktopEvent) => void) => { desktopListeners.add(listener); return () => desktopListeners.delete(listener); },
  getKeepAwakeStatus: async () => {
    const held = nextStatus; nextStatus = undefined; statusReads.push({ supported: status.supported, deferred: Boolean(held) });
    return held ? held.promise : structuredClone(status);
  },
  subscribeKeepAwakeStatus: (listener: () => void) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
  command: async (envelope: CommandEnvelope): Promise<CommandResult> => {
    commands.push(structuredClone(envelope));
    if (pendingCommand) throw new Error("Fixture received concurrent preference commands");
    const wait = deferred<"success" | "failure">(); pendingCommand = { envelope, wait };
    const outcome = await wait.promise; pendingCommand = undefined;
    if (outcome === "failure") return { ok: false, commandId: envelope.id, error: { code: "COMMAND_FAILED", message: "Controlled preference save failed" } };
    const command = envelope.command;
    if (command.type !== "preferences.put" || command.change.key !== "connections.keepAwakeWhilePluggedIn" || command.change.deleted) throw new Error("Unexpected preference command");
    const previous = records.find(record => record.key === command.change.key);
    const counter = (previous?.revision.counter ?? 0) + 1;
    const preference: PreferenceRecord = { key: command.change.key, value: command.change.value, deleted: false,
      revision: { counter, actor: preferenceActor, opId: envelope.id } };
    records = [preference];
    return { ok: true, commandId: envelope.id, value: { type: "preferences.put", preference } };
  },
} satisfies Pick<DesktopBridge, "getPreferences" | "subscribe" | "getKeepAwakeStatus" | "subscribeKeepAwakeStatus" | "command">;

const cache = { read: async () => null, write: async (key: string, value: string) => { cacheWrites.push({ key, value }); } };
const receiptValues = new Map<string, string>();
const receipts = { read: (key: string) => receiptValues.get(key) ?? null, write: (key: string, value: string) => { receiptValues.set(key, value); } };
const preferences = new PreferencesState(bridge, cache, receipts);
await preferences.restore(); preferences.setConnection(hostId, true); preferences.start(); await preferences.refresh();

createRoot(document.getElementById("root")!).render(<main><KeepAwakeSettings bridge={bridge} preferences={preferences}/></main>);
Object.assign(window, {
  keepAwakeState: () => ({
    text: document.body.innerText,
    switch: (() => { const node = document.querySelector<HTMLButtonElement>('[role="switch"]'); return node && { checked: node.getAttribute("aria-checked"), disabled: node.disabled, label: node.getAttribute("aria-label") }; })(),
    alerts: [...document.querySelectorAll<HTMLElement>('[role="alert"]')].filter(node => node.getClientRects().length).map(node => node.textContent?.trim()),
    preferences: preferences.get("connections.keepAwakeWhilePluggedIn"), preferenceReady: preferences.ready, preferenceBusy: preferences.busy,
    pendingPreferences: preferences.pending.map(item => item.id), preferenceError: preferences.error, records: structuredClone(records),
    status: structuredClone(status), statusReads: structuredClone(statusReads), commands: structuredClone(commands), cacheWrites: structuredClone(cacheWrites),
    pendingCommand: pendingCommand?.envelope,
  }),
  keepAwakeControl: (command: string, argument?: unknown) => {
    if (command === "release-initial-status") { initialStatus.resolve(structuredClone(status)); return; }
    if (command === "resolve-command") { if (!pendingCommand) throw new Error("No preference command is pending"); pendingCommand.wait.resolve("success"); return; }
    if (command === "fail-command") { if (!pendingCommand) throw new Error("No preference command is pending"); pendingCommand.wait.resolve("failure"); return; }
    if (command === "set-status") { status = structuredClone(argument as Status); return; }
    if (command === "emit-status") { for (const listener of statusListeners) listener(); return; }
    if (command === "capture-status-and-emit") {
      if (nextStatus || capturedStatus) throw new Error("A keep-awake status read is already held");
      capturedStatus = deferred<Status>(); nextStatus = capturedStatus; for (const listener of statusListeners) listener(); return;
    }
    if (command === "release-captured-status") { if (!capturedStatus) throw new Error("No captured status read exists"); const held = capturedStatus; capturedStatus = undefined; held.resolve(structuredClone(argument as Status)); return; }
    if (command === "emit-preferences") { for (const listener of desktopListeners) listener({ hostId, sequence: 1, type: "preferences" }); return; }
    throw new Error(`Unknown keep-awake fixture command ${command}`);
  },
});

declare global { interface Window { keepAwakeState(): unknown; keepAwakeControl(command: string, argument?: unknown): void } }
