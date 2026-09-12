import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import type { NativeTerminalAction, NativeTerminalAttachment, NativeTerminalInfo, NativeTerminalInputRequest, NativeTerminalInvalidation } from "../../../../packages/shared/src/terminals";
import { TERMINAL_DIMENSIONS } from "../../../../packages/shared/src/terminals";
import type { NativeTerminalClient } from "./native-terminal-bridge";
import { NativeTerminalView, type NativeTerminalViewState } from "./native-terminal-view";
import { NativeTerminalPanel } from "./NativeTerminalPanel";
import "@xterm/xterm/css/xterm.css";
import "./terminal-panel.css";
import "./native-terminal-panel.css";

/** Actual Electron DOM, React and xterm with an explicitly controlled transport fixture. */
export async function nativeTerminalBrowserAcceptance() {
  const checks: string[] = [], requireValue = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
  const settle = async (condition: () => boolean, label: string) => { for (let step = 0; step < 240; step++) { if (condition()) return; await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); } throw new Error(`Timed out: ${label}`); };
  const capture = async (name: string) => { if ((globalThis as any).nativeTerminalCaptureEnabled) await new Promise<void>(resolve => Object.assign(globalThis, { nativeTerminalCapturePhase: name, continueNativeTerminalCapture: () => { Object.assign(globalThis, { nativeTerminalCapturePhase: undefined }); resolve(); } })); };
  const panes: NativeTerminalInfo[] = ["pane-one", "pane-two"].map(id => ({ id, target: { projectId: "project" }, cwd: "/controlled-fixture", shell: "fixture", pid: 42, cols: 80, rows: 24, status: "running", attachable: true, createdAt: 1, protocol: "tmux-v1", serverGeneration: "server-one", geometryRevision: 1, inputEpoch: "epoch-one" }));
  const actions: NativeTerminalAction[] = [], inputs: NativeTerminalInputRequest[] = [], listeners = new Set<(event: NativeTerminalInvalidation & { hostId: string }) => void>();
  const attachments = new Map<string, NativeTerminalAttachment>(); let nextId = 0, forceGap: string | undefined, rejectNextInput = false, naturalExit = false;
  const emit = (event: NativeTerminalInvalidation) => { for (const listener of listeners) listener({ ...event, hostId: "host-one" }); };
  const client: NativeTerminalClient = {
    getNativeTerminalCapabilities: async () => ({ protocol: "tmux-v1", tmuxVersion: "3.7c", inputEpoch: "epoch-one", dimensions: TERMINAL_DIMENSIONS }),
    nativeTerminalQuery: async query => {
      if (query.type === "list") return { type: "list", terminals: panes.map(pane => ({ ...pane })) };
      if (query.type === "history") return { type: "history", history: { terminalId: query.terminalId, serverGeneration: "server-one", revision: "history-one", capturedAt: 1, cols: 80, rows: 24, live: true, history: "HISTORY IS READ ONLY\x1b[6n", screen: "CAPTURED CURRENT SCREEN", savedNormalScreen: "SAVED NORMAL SCREEN", truncated: false } };
      const attachment = attachments.get(query.attachmentId); if (!attachment) throw new Error("Expired fixture attachment");
      const terminal = panes.find(pane => pane.id === attachment.terminalId)!;
      const resetRequired = forceGap === attachment.id;
      if (resetRequired) forceGap = undefined;
      const chunks = [{ sequence: 1, data: `\x1b[2J\x1b[HATTACH ${attachment.id}\r\nNATIVE GRID ${terminal.cols}x${terminal.rows}\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[6n` }, ...(naturalExit && terminal.id === "pane-one" ? [{ sequence: 2, data: "\r\nFINAL OUTPUT BEFORE NATURAL EXIT" }] : [])];
      return { type: "replay", replay: { attachment: { ...attachment }, terminal: { ...terminal }, firstSequence: resetRequired ? 8 : 1, lastSequence: resetRequired ? 8 : chunks.length, resetRequired,
        chunks: resetRequired ? [{ sequence: 8, data: "FORBIDDEN RING TAIL" }] : chunks.filter(chunk => chunk.sequence > query.afterSequence) } };
    },
    nativeTerminalAction: async action => {
      actions.push(action);
      if (action.type === "attach") { const terminal = panes.find(pane => pane.id === action.terminalId)!; const attachment = { id: `attachment-${++nextId}`, terminalId: terminal.id, viewerId: action.viewerId, inputEpoch: terminal.inputEpoch, geometryRevision: terminal.geometryRevision, cols: terminal.cols, rows: terminal.rows, expiresAt: Date.now() + 30000 }; attachments.set(attachment.id, attachment); return { terminal: { ...terminal }, attachment }; }
      if (action.type === "detach") { attachments.delete(action.attachmentId); return { accepted: true }; }
      if (action.type === "heartbeat") { const attachment = attachments.get(action.attachmentId); return { attachment: attachment ? { ...attachment } : undefined, accepted: !!attachment }; }
      if (action.type === "reply") return { accepted: attachments.has(action.attachmentId) };
      if (action.type === "focus") return { accepted: attachments.has(action.attachmentId) };
      if (action.type === "resize") {
        const pane = panes.find(pane => pane.id === action.terminalId)!; requireValue(action.geometryRevision === pane.geometryRevision, "Resize supplies current generation");
        pane.cols = action.cols; pane.rows = action.rows; pane.geometryRevision++;
        for (const [id, attachment] of attachments) if (attachment.terminalId === pane.id) { attachments.delete(id); emit({ type: "detached", terminalId: pane.id, attachmentId: id }); }
        emit({ type: "state", terminal: { ...pane } }); return { terminal: { ...pane }, accepted: true };
      }
      throw new Error(`Unexpected fixture action: ${action.type}`);
    },
    writeNativeTerminal: async request => { inputs.push(request); if (rejectNextInput) { rejectNextInput = false; return { sequence: request.sequence, duplicate: false, outcome: "not-submitted", code: "STALE_TERMINAL_GEOMETRY" }; } return { sequence: request.sequence, duplicate: false, outcome: "accepted" }; },
    subscribeNativeTerminals: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const containers = [0, 1].map(() => { const outer = document.createElement("div"); outer.className = "native-terminal-scrollport"; outer.style.cssText = "width:330px;height:190px;flex:none;border:1px solid gray"; const inner = document.createElement("div"); inner.className = "native-terminal-grid"; outer.append(inner); document.body.append(outer); return { outer, inner }; });
  const focusTarget = document.createElement("input");
  const states: NativeTerminalViewState[] = [], views = containers.map((container, index) => new NativeTerminalView(container.inner, client, "host-one", { ...panes[0]! }, true, value => { states[index] = value; }));
  const terminal = (index: number) => (views[index] as unknown as { term: Terminal }).term;
  const attached = (index: number) => (views[index] as unknown as { attachment: NativeTerminalAttachment }).attachment;
  const text = (index: number) => Array.from({ length: terminal(index).rows }, (_, row) => terminal(index).buffer.active.getLine(row)?.translateToString(true)).join("\n");
  try {
    await settle(() => states.length === 2 && states.every(state => state.ready), "two native views ready");
    requireValue(attached(0).id !== attached(1).id, "Each actual DOM viewer owns an independent attachment");
    const parserReplies = actions.filter(action => action.type === "reply");
    requireValue(parserReplies.filter(action => action.type === "reply" && action.data.endsWith("R")).length === 2 && parserReplies.every(action => action.type === "reply" && action.outputSequence === 1 && action.ordinal >= 1), "Parser answers carry each attachment's real chunk identity");
    requireValue(terminal(0).cols === 80 && terminal(1).cols === 80, "Both xterms adopt accepted columns");
    await settle(() => containers.every(({ outer }) => outer.scrollWidth > outer.clientWidth && outer.scrollHeight > outer.clientHeight), "small panels scroll the full accepted grid");
    requireValue(!actions.some(action => action.type === "resize"), "Mounting differently sized viewers never silently resizes pane"); checks.push("independent attachments, live parser reply routing and full-grid DOM overflow");
    const originalTerms = [terminal(0), terminal(1)], originalHeight = terminal(0).element!.querySelector<HTMLElement>(".xterm-screen")!.getBoundingClientRect().height;
    const previousLineHeight = document.documentElement.style.getPropertyValue("--code-line-height");
    try {
      document.documentElement.style.setProperty("--code-line-height", "1.8");
      await settle(() => terminal(0).options.lineHeight === 1.8 && terminal(1).options.lineHeight === 1.8, "saved line-height reaches both existing emulators");
      await settle(() => terminal(0).element!.querySelector<HTMLElement>(".xterm-screen")!.getBoundingClientRect().height > originalHeight, "line-height changes actual rendered grid");
      requireValue(terminal(0) === originalTerms[0] && terminal(1) === originalTerms[1] && terminal(0).cols === 80 && terminal(0).rows === 24 && !actions.some(action => action.type === "resize"), "Theme geometry preserves emulators and accepted PTY dimensions");
    } finally { if (previousLineHeight) document.documentElement.style.setProperty("--code-line-height", previousLineHeight); else document.documentElement.style.removeProperty("--code-line-height"); }
    await settle(() => terminal(0).options.lineHeight === 1.2 && terminal(1).options.lineHeight === 1.2, "removed override restores pinned fallback");
    checks.push("saved line-height updates real existing grids without resizing PTYs; removal restores the pinned fallback");
    await capture("two-viewers");
    terminal(0).textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", bubbles: true, cancelable: true }));
    terminal(0).textarea!.dispatchEvent(new KeyboardEvent("keypress", { key: "λ", charCode: 955, keyCode: 955, bubbles: true, cancelable: true }));
    const clipboard = new DataTransfer(); clipboard.setData("text/plain", "raw paste\nλ"); terminal(0).textarea!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
    const screen = terminal(0).element!.querySelector<HTMLElement>(".xterm-screen")!, rect = screen.getBoundingClientRect();
    screen.dispatchEvent(new MouseEvent("mousedown", { button: 0, buttons: 1, clientX: rect.left + rect.width / 80 * 4.5, clientY: rect.top + rect.height / 24 * 3.5, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0, buttons: 0, clientX: rect.left + rect.width / 80 * 4.5, clientY: rect.top + rect.height / 24 * 3.5, bubbles: true, cancelable: true }));
    await settle(() => inputs.some(input => input.input.kind === "mouse") && inputs.some(input => input.input.kind === "paste"), "DOM keyboard/paste/mouse admitted");
    requireValue(inputs.some(request => request.input.kind === "key" && request.input.key === "Up"), "DOM ArrowUp stays a native key");
    requireValue(inputs.some(request => request.input.kind === "text" && request.input.data === "λ"), "DOM character input preserves Unicode");
    requireValue(inputs.some(request => request.input.kind === "paste" && request.input.data === "raw paste\nλ"), "DOM paste retains raw pre-wrapper content");
    requireValue(inputs.some(request => request.input.kind === "mouse" && request.input.col === 5 && request.input.row === 4), "DOM mouse maps full-grid coordinates"); checks.push("actual DOM key, Unicode, paste and cell-coordinate mouse input");
    terminal(0).textarea!.dispatchEvent(new FocusEvent("blur")); terminal(0).textarea!.dispatchEvent(new FocusEvent("focus"));
    requireValue(actions.some(action => action.type === "focus" && action.focused === false) && actions.some(action => action.type === "focus" && action.focused === true), "DOM focus reports use attachment metadata");
    requireValue(!inputs.some(request => request.input.kind === "text" && ["\x1b[I", "\x1b[O"].includes(request.input.data)), "Focus never becomes pane keyboard text");
    if ((terminal(0) as any)._core.browser.isMac) {
      terminal(0).textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", keyCode: 65, altKey: true, bubbles: true, cancelable: true }));
      terminal(0).textarea!.dispatchEvent(new KeyboardEvent("keypress", { key: "å", charCode: 229, keyCode: 229, altKey: true, bubbles: true, cancelable: true }));
      await settle(() => inputs.some(request => request.input.kind === "text" && request.input.data === "å"), "native xterm Option text handling"); requireValue(!inputs.some(request => request.input.kind === "key" && request.input.key === "M-a"), "Option composition is not rewritten as Meta key");
    }
    checks.push("DOM focus stays attachment metadata and platform composition remains text");
    const beforeGap = attached(0).id, beforeTerm = terminal(0); forceGap = beforeGap; views[0]!.refresh();
    await settle(() => attached(0)?.id !== beforeGap && states[0]!.ready, "fresh view after ring loss");
    requireValue(terminal(0) !== beforeTerm && !text(0).includes("FORBIDDEN"), "Fresh xterm never parses evicted tail"); requireValue(attached(1).id === "attachment-2", "One gap does not replace another viewer"); checks.push("ring loss recreates only affected native attachment and emulator");
    document.body.append(focusTarget); focusTarget.focus();
    const old = attached(0).id; views[0]!.setConnected(false); requireValue(terminal(0).options.disableStdin, "Disconnect disables real terminal stdin"); views[0]!.setConnected(true);
    await settle(() => attached(0)?.id !== old && states[0]!.ready, "reconnect attaches same pane"); requireValue(inputs.every(input => input.input.kind !== "text" || input.input.data !== "FORBIDDEN"), "Reconnect does not manufacture input"); checks.push("disconnect and reconnect preserve pane and replace only display transport");
    requireValue(document.activeElement === focusTarget, "Reconnect does not steal another input's focus");
    focusTarget.remove(); terminal(0).focus();
    const beforeResize = [attached(0).id, attached(1).id]; await views[0]!.usePanelSize();
    await settle(() => states.every(state => state.ready) && attached(0).id !== beforeResize[0] && attached(1).id !== beforeResize[1], "shared resize replaces both attachments");
    requireValue(actions.filter(action => action.type === "resize").length === 1, "Explicit resize sends one shared native resize"); requireValue(terminal(0).cols === terminal(1).cols && terminal(0).rows === terminal(1).rows && terminal(0).cols < 80, "Every actual emulator adopts resized accepted grid"); checks.push("one intentional resize updates every viewer before input acknowledgement");
    requireValue(document.activeElement === terminal(0).textarea, "Shared resize restores only the previously focused viewer");
    checks.push("attachment replacement preserves external focus and the focused terminal viewer");
    rejectNextInput = true; terminal(0).textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", bubbles: true, cancelable: true }));
    await settle(() => states[0]!.inputPaused, "stale input visible"); requireValue(states[0]!.inputError?.includes("STALE_TERMINAL_GEOMETRY"), "Stale native admission surfaces exact code"); requireValue(terminal(0).options.disableStdin, "Stale receipt disables actual stdin"); views[0]!.resumeInput(); await settle(() => !states[0]!.inputPaused, "explicit input resume"); checks.push("stale receipt surfaces and pauses real input without replay");
    naturalExit = true; panes[0]!.status = "exited"; panes[0]!.exitCode = 0; emit({ type: "state", terminal: { ...panes[0]! } });
    await settle(() => text(0).includes("FINAL OUTPUT") && text(1).includes("FINAL OUTPUT"), "final native attachment bytes after exit"); requireValue(terminal(0).options.disableStdin && terminal(1).options.disableStdin, "Exited panes drain output with input disabled"); checks.push("natural exit drains final attachment output and keeps stdin disabled");
    for (const view of views) view.dispose(); for (const container of containers) container.outer.remove(); requireValue(!actions.some(action => action.type === "close" || action.type === "forget"), "Disposing views never kills or forgets panes");
    const panel = document.createElement("div"); panel.style.cssText = "width:620px;height:400px"; document.body.append(panel); const root = createRoot(panel);
    try {
      flushSync(() => root.render(createElement(NativeTerminalPanel, { bridge: client, hostId: "host-one", target: { projectId: "project" }, connected: true, onClose() {} })));
      await settle(() => panel.querySelectorAll('[role="tab"]').length === 2 && panel.querySelector(".xterm") !== null && !panel.textContent?.includes("Attaching to the native pane"), "actual React native panel");
      await capture("panel-wide"); panel.style.width = "330px"; await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); await capture("panel-narrow");
      const inactiveTab = panel.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!, attachCount = nextId;
      inactiveTab.click(); await settle(() => nextId > attachCount, "switch tab gets its own native view");
      const history = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "History")!; history.click();
      await settle(() => panel.querySelector(".native-terminal-history pre")?.textContent?.includes("HISTORY IS READ ONLY") === true, "native history rendered as read-only text");
      requireValue(panel.querySelector(".native-terminal-history pre")!.textContent!.includes("\x1b[6n"), "History escape sequences stay text, never parser input");
      requireValue(panel.querySelector('[aria-label="Captured native screen"]')?.textContent === "CAPTURED CURRENT SCREEN", "Native current screen remains separately readable in history");
      checks.push("React tabs detach views without closing panes; history stays read-only text");
    } finally { root.unmount(); panel.remove(); }
    requireValue(!actions.some(action => action.type === "close" || action.type === "forget"), "Unmounted panel retains underlying panes");
    return { passed: true, checks, actions: { attachments: nextId, sharedResizes: actions.filter(action => action.type === "resize").length, closes: actions.filter(action => action.type === "close").length, replies: actions.filter(action => action.type === "reply").length }, electron: navigator.userAgent, source: "Production native renderer in real Electron DOM/React/xterm; controlled transport fixture, not native tmux or installed-app acceptance" };
  } finally { focusTarget.remove(); for (const view of views) view.dispose(); for (const container of containers) container.outer.remove(); }
}
Object.assign(globalThis, { runNativeTerminalBrowserAcceptance: nativeTerminalBrowserAcceptance });
