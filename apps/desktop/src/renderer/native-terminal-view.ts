import { Terminal } from "@xterm/xterm";
import type { NativeTerminalAttachment, NativeTerminalInfo } from "../../../../packages/shared/src/terminals";
import type { NativeTerminalClient } from "./native-terminal-bridge";
import { TERMINAL_DIMENSIONS } from "../../../../packages/shared/src/terminals";
import { separateXtermReplies } from "./xterm-input";
import { wireNativeXtermInput } from "./native-xterm-input";
import { NativeTerminalInputQueue, NativeTerminalReplayCursor, newestNativeTerminal } from "./native-terminal-state";

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const attachable = (terminal: NativeTerminalInfo) => terminal.attachable ?? (["running", "starting", "closing"].includes(terminal.status) || terminal.status === "exited" && terminal.cancelled !== true);
export interface NativeTerminalViewState { terminal: NativeTerminalInfo; ready: boolean; restoring: boolean; error?: string; inputError?: string; inputPaused: boolean; inputBusy: boolean; hasSelection: boolean }

/** One mounted viewport, one attachment. Disposal only detaches this viewer; it never closes a pane. */
export class NativeTerminalView {
  private viewerId = crypto.randomUUID();
  private attachment?: NativeTerminalAttachment;
  private terminal: NativeTerminalInfo;
  private term?: Terminal;
  private parser?: ReturnType<typeof separateXtermReplies>;
  private cursor?: NativeTerminalReplayCursor;
  private disposeEmulator?: () => void;
  private input: NativeTerminalInputQueue;
  private alive = true;
  private connected: boolean;
  private refreshing = false;
  private requested = false;
  private fresh = true;
  private attachmentRevision = 0;
  private ready = false;
  private restoring = true;
  private error?: string;
  private resizeBusy = false;
  private off: () => void;
  private timer: ReturnType<typeof setInterval>;
  private themeObserver: MutationObserver;
  private sizeObserver: ResizeObserver;
  private dark = matchMedia("(prefers-color-scheme: dark)");
  constructor(private element: HTMLElement, private bridge: NativeTerminalClient, private hostId: string, terminal: NativeTerminalInfo, connected: boolean, private changed: (state: NativeTerminalViewState) => void) {
    this.terminal = terminal; this.connected = connected;
    this.input = new NativeTerminalInputQueue(terminal.id, request => bridge.writeNativeTerminal(request, hostId), () => this.publish());
    this.input.setConnected(connected);
    this.off = bridge.subscribeNativeTerminals(event => {
      if (event.hostId !== hostId) return;
      if (event.type === "state" && event.terminal.id === this.terminal.id) this.updateTerminal(event.terminal);
      else if (event.type === "output" && event.attachmentId === this.attachment?.id && event.lastSequence > (this.cursor?.sequence ?? 0)) this.refresh();
      else if (event.type === "detached" && event.attachmentId === this.attachment?.id) { this.restart(); this.refresh(); }
      else if (event.type === "removed" && event.terminalId === this.terminal.id) { this.error = "This terminal was removed."; this.setConnected(false); }
    });
    this.themeObserver = new MutationObserver(this.applyTheme); this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    this.sizeObserver = new ResizeObserver(this.sizeGrid); this.sizeObserver.observe(element);
    this.dark.addEventListener("change", this.applyTheme);
    this.timer = setInterval(() => this.refresh(), 2000);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.refresh();
  }
  private publish = () => {
    if (!this.alive || !this.input) return;
    if (this.term) this.term.options.disableStdin = !this.ready || !this.input.ready || this.terminal.status !== "running";
    this.changed({ terminal: this.terminal, ready: this.ready, restoring: this.restoring, error: this.error, inputError: this.input.error, inputPaused: this.input.paused, inputBusy: this.input.busy, hasSelection: this.term?.hasSelection() ?? false });
  };
  private restart(reason?: string): void {
    this.attachmentRevision++; this.fresh = true; this.ready = false; this.restoring = attachable(this.terminal);
    this.input.setGeneration(undefined); if (reason) this.error = reason; this.publish();
  }
  updateTerminal(value: NativeTerminalInfo): void {
    const next = newestNativeTerminal(this.terminal, value);
    const changed = next.geometryRevision !== this.terminal.geometryRevision || next.inputEpoch !== this.terminal.inputEpoch || next.serverGeneration !== this.terminal.serverGeneration;
    this.terminal = next;
    if (changed) this.restart();
    if (!attachable(next)) { this.ready = false; this.restoring = false; }
    this.publish(); this.refresh();
  }
  setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected; this.input.setConnected(connected); this.restart();
    if (connected) this.refresh();
  }
  private onVisibility = () => { if (document.visibilityState !== "hidden") this.refresh(); };
  refresh(): void {
    this.requested = true;
    if (this.refreshing || !this.alive || !this.connected) return;
    if (!attachable(this.terminal)) { this.restoring = false; this.publish(); return; }
    this.refreshing = true;
    void this.sync().catch(cause => { if (this.alive) this.restart(errorText(cause)); }).finally(() => { this.refreshing = false; });
  }
  private async sync(): Promise<void> {
    let replacements = 0;
    do {
      this.requested = false;
      if (!this.alive || !this.connected) return;
      if (this.fresh || !this.attachment) {
        if (++replacements > 3) throw new Error("The terminal is producing output faster than this view can restore. It will retry with a fresh attachment.");
        const revision = this.attachmentRevision, previous = this.attachment; this.attachment = undefined;
        this.disposeEmulator?.(); this.disposeEmulator = undefined;
        if (previous) await this.bridge.nativeTerminalAction({ type: "detach", attachmentId: previous.id }, this.hostId).catch(() => {});
        const result = await this.bridge.nativeTerminalAction({ type: "attach", terminalId: this.terminal.id, viewerId: this.viewerId }, this.hostId);
        if (!result.attachment || !result.terminal) throw new Error("The host did not return a native terminal attachment.");
        if (!this.alive || !this.connected) { void this.bridge.nativeTerminalAction({ type: "detach", attachmentId: result.attachment.id }, this.hostId).catch(() => {}); return; }
        this.terminal = newestNativeTerminal(this.terminal, result.terminal);
        if (revision !== this.attachmentRevision || result.attachment.geometryRevision !== this.terminal.geometryRevision || result.attachment.inputEpoch !== this.terminal.inputEpoch) { await this.bridge.nativeTerminalAction({ type: "detach", attachmentId: result.attachment.id }, this.hostId).catch(() => {}); this.requested = true; continue; }
        this.attachment = result.attachment; this.fresh = false;
        this.createEmulator(result.attachment); this.input.setGeneration(result.attachment);
      }
      const attachment = this.attachment!;
      const result = await this.bridge.nativeTerminalQuery({ type: "replay", attachmentId: attachment.id, afterSequence: this.cursor!.sequence }, this.hostId);
      if (!this.alive || !this.connected) return;
      if (this.fresh) { this.requested = true; continue; }
      if (result.type !== "replay") throw new Error("The host returned an invalid native replay result.");
      const applied = await this.cursor!.apply(result.replay);
      if (!this.alive || !this.connected) return;
      if (applied === "reset-required") { this.restart("Recovering a fresh native view after an attachment gap."); this.requested = true; continue; }
      if (applied === "stale" || this.fresh) { this.requested = true; continue; }
      this.terminal = newestNativeTerminal(this.terminal, result.replay.terminal);
      const heartbeat = await this.bridge.nativeTerminalAction({ type: "heartbeat", attachmentId: attachment.id, afterSequence: this.cursor!.sequence, geometryRevision: attachment.geometryRevision }, this.hostId);
      if (!this.alive || !this.connected || this.fresh) continue;
      if (!heartbeat.attachment || heartbeat.attachment.id !== attachment.id || heartbeat.attachment.geometryRevision !== attachment.geometryRevision || heartbeat.attachment.inputEpoch !== attachment.inputEpoch) { this.restart(); this.requested = true; continue; }
      this.attachment = heartbeat.attachment; this.input.acknowledge(heartbeat.attachment);
      this.ready = true; this.restoring = false; this.error = undefined; this.publish();
    } while (this.requested && this.alive && this.connected);
  }
  private createEmulator(attachment: NativeTerminalAttachment): void {
    this.element.replaceChildren();
    // A fresh emulator also discards any unfinished parser escape sequence from an old PTY.
    const term = new Terminal({ cols: attachment.cols, rows: attachment.rows, scrollback: 5000, cursorBlink: true, screenReaderMode: true, allowTransparency: true, allowProposedApi: false, disableStdin: true, fontFamily: "monospace", fontSize: 13 });
    term.open(this.element); this.term = term; term.textarea?.setAttribute("aria-label", `Interactive ${this.terminal.shell} terminal`);
    const parser = separateXtermReplies(term); this.parser = parser;
    const input = wireNativeXtermInput(term, value => this.input.enqueue(value), () => this.ready && this.input.ready && this.terminal.status === "running", { copy: text => this.copy(text), selectAll: () => term.selectAll() }, focused => {
      if (!this.alive || !this.connected || this.fresh || this.attachment?.id !== attachment.id) return;
      void this.bridge.nativeTerminalAction({ type: "focus", attachmentId: attachment.id, focused }, this.hostId).catch(() => { if (this.alive && this.attachment?.id === attachment.id) { this.restart("Terminal focus delivery was interrupted. Restoring its native attachment."); this.refresh(); } });
    });
    const selection = term.onSelectionChange(this.publish), render = term.onRender(this.sizeGrid);
    this.cursor = new NativeTerminalReplayCursor(() => {}, async chunks => {
      const replies = await parser.writeBatch(chunks);
      for (const reply of replies) {
        if (!this.alive || !this.connected || this.fresh || this.attachment?.id !== attachment.id) return;
        try {
          const result = await this.bridge.nativeTerminalAction({ type: "reply", attachmentId: attachment.id, ...reply }, this.hostId);
          if (result.accepted !== true) { this.restart("The terminal reply attachment expired. Restoring a fresh native view."); return; }
        } catch { this.restart("Terminal reply delivery was interrupted. Restoring a fresh native view."); return; }
      }
    });
    this.cursor.begin(attachment);
    this.disposeEmulator = () => { input.dispose(); parser.dispose(); selection.dispose(); render.dispose(); term.dispose(); if (this.term === term) this.term = undefined; };
    this.applyTheme(); this.sizeGrid(); term.focus(); this.publish();
  }
  private sizeGrid = () => {
    const term = this.term, screen = term?.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!term?.element || !screen) return;
    const width = parseFloat(screen.style.width), height = parseFloat(screen.style.height);
    if (Number.isFinite(width) && width > 0) term.element.style.width = `${Math.ceil(width + 16)}px`;
    if (Number.isFinite(height) && height > 0) term.element.style.height = `${Math.ceil(height)}px`;
  };
  private applyTheme = () => {
    const term = this.term; if (!term) return;
    const style = getComputedStyle(document.documentElement), token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true }); canvas.width = canvas.height = 1;
    const color = (value: string) => { if (!context) return value; context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data; return `rgba(${r},${g},${b},${a! / 255})`; };
    const measure = document.createElement("span"); measure.style.fontSize = token("--terminal-font-size", token("--code-font-size", "13px")); this.element.append(measure); const fontSize = parseFloat(getComputedStyle(measure).fontSize); measure.remove();
    term.options = { theme: { background: color(token("--terminal-surface", token("--app-surface", "#181818"))), foreground: color(token("--text", "#ededed")), cursor: color(token("--accent", "#72a8ff")), selectionBackground: color(token("--selection-surface", "#ffffff33")) }, fontFamily: token("--terminal-font", token("--code-font", "monospace")), fontSize: Number.isFinite(fontSize) ? fontSize : 13, fontWeight: Number(token("--code-font-weight", "400")), lineHeight: Number(token("--code-line-height", "1.2")) };
    this.sizeGrid();
  };
  async usePanelSize(): Promise<void> {
    if (!this.connected || !this.ready || !this.attachment || !this.term || this.resizeBusy || this.terminal.status !== "running") return;
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen"), viewport = this.element.parentElement;
    const width = parseFloat(screen?.style.width ?? ""), height = parseFloat(screen?.style.height ?? "");
    if (!viewport || !(width > 0 && height > 0)) return;
    const cols = Math.max(TERMINAL_DIMENSIONS.minimumCols, Math.min(TERMINAL_DIMENSIONS.maximumCols, Math.floor((viewport.clientWidth - 20) / (width / this.term.cols))));
    const rows = Math.max(TERMINAL_DIMENSIONS.minimumRows, Math.min(TERMINAL_DIMENSIONS.maximumRows, Math.floor((viewport.clientHeight - 8) / (height / this.term.rows))));
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.resizeBusy = true; this.ready = false; this.publish();
    try {
      const result = await this.bridge.nativeTerminalAction({ type: "resize", terminalId: this.terminal.id, attachmentId: this.attachment.id, geometryRevision: this.attachment.geometryRevision, cols, rows }, this.hostId);
      if (!result.terminal) throw new Error("The host did not return the accepted shared grid.");
      this.updateTerminal(result.terminal); this.refresh();
    } catch (cause) { this.error = `The shared grid was not confirmed: ${errorText(cause)}`; this.restart(); this.refresh(); }
    finally { this.resizeBusy = false; this.publish(); }
  }
  private copy(text: string): void { void navigator.clipboard.writeText(text).catch(cause => { this.error = errorText(cause); this.publish(); }); }
  copySelection(): void { if (this.term) this.copy(this.term.getSelection()); }
  resumeInput(): void { this.input.resume(); this.publish(); this.term?.focus(); }
  focus(): void { this.term?.focus(); }
  dispose(): void {
    if (!this.alive) return;
    this.alive = false; this.off(); clearInterval(this.timer); this.themeObserver.disconnect(); this.sizeObserver.disconnect(); this.dark.removeEventListener("change", this.applyTheme); document.removeEventListener("visibilitychange", this.onVisibility);
    this.input.dispose(); this.disposeEmulator?.();
    const attachment = this.attachment; this.attachment = undefined;
    if (attachment) void this.bridge.nativeTerminalAction({ type: "detach", attachmentId: attachment.id }, this.hostId).catch(() => {});
  }
}
