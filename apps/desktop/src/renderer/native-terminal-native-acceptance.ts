import type { Terminal } from "@xterm/xterm";
import type { NativeTerminalAttachment, NativeTerminalBridge, NativeTerminalInvalidation, NativeTerminalResult } from "../../../../packages/shared/src/terminals";
import { nativeTerminalClient } from "./native-terminal-bridge";
import { NativeTerminalView, type NativeTerminalViewState } from "./native-terminal-view";
import "@xterm/xterm/css/xterm.css";
import "./native-terminal-panel.css";

/** Source acceptance: production renderer + HTTP + bundled tmux and a real raw TUI. No provider. */
export async function nativeTerminalNativeAcceptance() {
  const config = await (await fetch("/fixture/bootstrap")).json(), checks: string[] = [];
  const requireValue = (value: unknown, label: string) => { if (!value) throw new Error(label); };
  const until = async (check: () => boolean | Promise<boolean>, label: string) => { for (let i = 0; i < 800; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 15)); } throw new Error(`Timed out: ${label}`); };
  const request = async <T>(route: string, body?: unknown): Promise<NativeTerminalResult<T>> => { const response = await fetch(route, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const result = await response.json(); return response.ok ? { ok: true, value: result } : { ok: false, error: { ...result.error, status: response.status } }; };
  const listeners = new Set<(event: NativeTerminalInvalidation & { hostId: string }) => void>();
  const events = new WebSocket(location.origin.replace("http", "ws") + "/events"); events.addEventListener("message", event => { const value = JSON.parse(event.data); for (const listener of listeners) listener(value); });
  await new Promise<void>((resolve, reject) => { events.addEventListener("open", () => resolve(), { once: true }); events.addEventListener("error", reject, { once: true }); });
  let heldAttachment: string | undefined, releaseHeld: (() => void) | undefined, heldReads = 0;
  let gate: Promise<void> | undefined; const actions: string[] = []; let observedGap = false;
  const bridge: NativeTerminalBridge = {
    getNativeTerminalCapabilities: () => request("/v2/terminals/capabilities"),
    nativeTerminalQuery: async query => { if (query.type === "replay" && query.attachmentId === heldAttachment) { heldReads++; await gate; } const result = await request<any>("/v2/terminals/query", query); if (result.ok && result.value.type === "replay" && result.value.replay.resetRequired) observedGap = true; return result; },
    nativeTerminalAction: action => { actions.push(action.type); return request("/v2/terminals/action", action); },
    writeNativeTerminal: input => request("/v2/terminals/input", input), subscribeNativeTerminals: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const client = nativeTerminalClient(bridge); const capabilities = await client.getNativeTerminalCapabilities(config.hostId); requireValue(capabilities.protocol === "tmux-v1", "Real host explicitly negotiates tmux-v1");
  const created = await client.nativeTerminalAction({ type: "create", options: { target: { projectId: config.projectId }, cols: 80, rows: 24 } }, config.hostId); const info = created.terminal!;
  const state = async () => (await (await fetch("/fixture/state")).json()) as { state?: { pid: number; done: number; winches: number }; input: string };
  const control = async (type: string, data = "") => { const value = await (await fetch("/fixture/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, data }) })).json(); await until(async () => (await state()).state?.done === value.id, `native control ${type}`); };
  const bytes = async () => atob((await state()).input);
  const containers = [0, 1].map(() => { const outer = document.createElement("div"); outer.className = "native-terminal-scrollport"; outer.style.cssText = "width:430px;height:270px;flex:none;border:1px solid #777"; const inner = document.createElement("div"); inner.className = "native-terminal-grid"; outer.append(inner); document.body.append(outer); return { outer, inner }; });
  const states: NativeTerminalViewState[] = [], views = containers.map((value, index) => new NativeTerminalView(value.inner, client, config.hostId, info, true, next => { states[index] = next; }));
  const terminal = (index: number) => (views[index] as unknown as { term: Terminal }).term, attachment = (index: number) => (views[index] as unknown as { attachment: NativeTerminalAttachment }).attachment;
  const screen = (index: number) => Array.from({ length: terminal(index)?.rows ?? 0 }, (_, row) => terminal(index).buffer.active.getLine(row)?.translateToString(true)).join("\n");
  try {
    await until(() => states.length === 2 && states.every(value => value.ready) && screen(0).includes("REAL NATIVE HEADER") && screen(1).includes("REAL NATIVE HEADER"), "both real native attachment screens");
    const pid = (await state()).state!.pid; requireValue(pid === info.pid, "Native catalog owns actual TUI PID"); requireValue((await state()).state!.winches === 0, "Attachment has no synthetic resize"); checks.push("two real Electron views attach the same native pane at its accepted grid");
    const before = (await bytes()).length;
    terminal(0).textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", keyCode: 38, bubbles: true, cancelable: true }));
    const clipboard = new DataTransfer(); clipboard.setData("text/plain", "NATIVE_PASTE\nλ"); terminal(0).textarea!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    const nativeScreen = terminal(0).element!.querySelector<HTMLElement>(".xterm-screen")!, rect = nativeScreen.getBoundingClientRect();
    nativeScreen.dispatchEvent(new MouseEvent("mousedown", { button: 0, buttons: 1, clientX: rect.left + rect.width / 80 * 4.5, clientY: rect.top + rect.height / 24 * 3.5, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, buttons: 0, clientX: rect.left + rect.width / 80 * 4.5, clientY: rect.top + rect.height / 24 * 3.5, bubbles: true, cancelable: true }));
    await until(async () => (await bytes()).slice(before).includes("\x1bOA") && (await bytes()).slice(before).includes("\x1b[200~NATIVE_PASTE\r") && (await bytes()).slice(before).includes("\x1b[<0;5;4M"), "native mode-aware key, paste and mouse bytes");
    requireValue((await bytes()).slice(before).includes("\x1b[201~"), "One native paste wrapper closes"); checks.push("real DOM arrow, paste and mouse reach the program under native pane modes");
    const first = attachment(0).id; heldAttachment = first; gate = new Promise<void>(resolve => { releaseHeld = resolve; }); views[0]!.refresh(); await until(() => heldReads > 0, "first attachment is deliberately lagged");
    await control("flood"); await until(() => screen(1).includes("FINAL ACTUAL NATIVE FRAME"), "second native view remains live during lag");
    const beforeMarker = (await bytes()).length; terminal(1).input("SECOND_VIEW_RESPONSIVE", true); await until(async () => (await bytes()).slice(beforeMarker).includes("SECOND_VIEW_RESPONSIVE"), "live viewer input during another's lag");
    heldAttachment = undefined; releaseHeld!();
    await until(() => observedGap && attachment(0)?.id !== first && states[0]!.ready && screen(0).includes("REAL NATIVE HEADER") && screen(0).includes("FINAL ACTUAL NATIVE FRAME"), "lost ring restores actual current TUI");
    requireValue((await state()).state!.pid === pid && (await state()).state!.winches === 0, "Lag recovery neither restarts nor synthetically resizes native program"); checks.push("actual native ring eviction recovers current TUI while second viewer types");
    requireValue(((await bytes()).match(/\x1b\[[0-9]+;[0-9]+R/g) ?? []).length === 1, "Underlying program receives one native answer to its one cursor query across viewers/recovery"); checks.push("the program receives one native query answer across all viewer attachments");
    await control("output", "\x1b[12;"); const secondId = attachment(1).id; views[1]!.setConnected(false); views[1]!.setConnected(true); await until(() => attachment(1)?.id !== secondId && states[1]!.ready, "fresh second native attachment");
    await control("output", "5HREAL_CONTINUATION"); await until(() => screen(0).includes("REAL_CONTINUATION") && screen(1).includes("REAL_CONTINUATION"), "partial native CSI survives attachment change"); checks.push("native pending escape state continues after a viewer reconnects");
    const beforeResize = [attachment(0).id, attachment(1).id]; await views[0]!.usePanelSize();
    await until(() => states.every(value => value.ready) && attachment(0).id !== beforeResize[0] && attachment(1).id !== beforeResize[1], "both actual views adopt intentional resize");
    requireValue(terminal(0).cols === terminal(1).cols && terminal(0).rows === terminal(1).rows, "Native shared grid agrees across viewers"); await until(async () => (await state()).state!.winches === 1, "exactly one native SIGWINCH"); checks.push("one explicit resize updates native pane and every attached xterm");
    await control("exit"); await until(() => states.every(value => value.terminal.status === "exited") && screen(0).includes("REAL FINAL EXIT OUTPUT") && screen(1).includes("REAL FINAL EXIT OUTPUT"), "actual exited pane final output");
    requireValue(terminal(0).options.disableStdin && terminal(1).options.disableStdin, "Real exited pane input is disabled"); const history = await client.nativeTerminalQuery({ type: "history", terminalId: info.id }, config.hostId); requireValue(history.type === "history" && `${history.history.history}\n${history.history.screen}`.includes("REAL FINAL EXIT OUTPUT"), "Native history includes final actual screen"); checks.push("natural native exit drains final output and captures final history");
    for (const view of views) view.dispose(); requireValue(!actions.includes("close"), "Viewer disposal sends no native pane close");
    const result = { passed: true, checks, protocol: capabilities.protocol, nativeVersion: capabilities.tmuxVersion, programPid: pid, acceptedGrid: { cols: terminal(0)?.cols ?? states[0]!.terminal.cols, rows: terminal(0)?.rows ?? states[0]!.terminal.rows }, observedGap, nativeResizes: (await state()).state!.winches, inputBytes: (await bytes()).length, source: "Production renderer and HTTP/manager through real Electron, bundled native tmux3.7c and a disposable raw TUI; no installed app/provider/auth/config" };
    return result;
  } finally { heldAttachment = undefined; releaseHeld?.(); for (const view of views) view.dispose(); events.close(); for (const container of containers) container.outer.remove(); }
}
Object.assign(globalThis, { runNativeTerminalNativeAcceptance: nativeTerminalNativeAcceptance });
