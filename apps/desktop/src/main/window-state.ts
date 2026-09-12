import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { parseWindowView, type WindowStateBootstrap, type WindowViewState } from "../window-state";
export interface WindowBounds { x: number; y: number; width: number; height: number }
interface WindowDocument { version: 1; view?: WindowViewState; bounds?: WindowBounds; maximized?: boolean }
const maximumBytes = 512 * 1024;
function bounds(value: unknown): WindowBounds | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as WindowBounds;
  if (![v.x, v.y, v.width, v.height].every(Number.isSafeInteger) || Math.abs(v.x) > 100000 || Math.abs(v.y) > 100000 || v.width < 720 || v.height < 480 || v.width > 32000 || v.height > 32000) return;
  return { x: v.x, y: v.y, width: v.width, height: v.height };
}
/** One main-process owner per window slot. Reads never depend on the host daemon. */
export class WindowStateStore {
  readonly file: string;
  private document: WindowDocument = { version: 1 };
  private readError?: string;
  private writeError?: string;
  constructor(profile: string, readonly slot: string) {
    if (!/^[a-z0-9-]{1,80}$/.test(slot)) throw new Error("Invalid local window slot.");
    this.file = join(profile, `window-${slot}-v1.json`);
    try {
      if (!existsSync(this.file)) return;
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: unknown;
      try { const info = fstatSync(fd); if (!info.isFile() || info.size > maximumBytes) throw new Error("Invalid window state size."); raw = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
      const saved = raw as WindowDocument;
      if (!saved || saved.version !== 1 || (saved.view !== undefined && !parseWindowView(saved.view)) || (saved.bounds !== undefined && !bounds(saved.bounds)) || (saved.maximized !== undefined && typeof saved.maximized !== "boolean")) throw new Error("Invalid window state.");
      this.document = { version: 1, ...(saved.view ? { view: parseWindowView(saved.view)! } : {}), ...(saved.bounds ? { bounds: bounds(saved.bounds)! } : {}), ...(saved.maximized === undefined ? {} : { maximized: saved.maximized }) };
    } catch { this.readError = "The saved window layout could not be read. This window is using defaults."; }
  }
  bootstrap(): WindowStateBootstrap { const error = this.writeError ?? this.readError; return { ownerSlot: this.slot, ...(this.document.view ? { state: structuredClone(this.document.view) } : {}), ...(error ? { error } : {}) }; }
  geometry() { return { bounds: this.document.bounds ? { ...this.document.bounds } : undefined, maximized: this.document.maximized ?? false }; }
  saveView(value: unknown): { error?: string } {
    const view = parseWindowView(value);
    if (!view) return { error: "The window layout was invalid and could not be saved." };
    const result = this.write({ ...this.document, view });
    if (!result.error) this.readError = undefined;
    return result;
  }
  saveGeometry(value: WindowBounds, maximized: boolean): { error?: string } {
    const geometry = bounds(value); if (!geometry || typeof maximized !== "boolean") return { error: "The window bounds could not be saved." };
    return this.write({ ...this.document, bounds: geometry, maximized });
  }
  private write(next: WindowDocument): { error?: string } {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const serialized = JSON.stringify(next) + "\n";
      if (Buffer.byteLength(serialized, "utf8") > maximumBytes) throw new Error("Window state exceeds the readable document limit.");
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, serialized, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      // The rename must reach the directory before its new view is acknowledged.
      const directory = openSync(dirname(this.file), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.document = next; this.writeError = undefined; return {};
    } catch { this.writeError = "This window’s layout could not be saved on this device. Navigation remains available."; return { error: this.writeError }; }
    finally { try { unlinkSync(temporary); } catch { /* Missing staging files need no cleanup. */ } }
  }
}
/** Preserve usable size while ensuring a disconnected monitor cannot hide the titlebar. */
export function restoreWindowBounds(saved: WindowBounds | undefined, workAreas: WindowBounds[]): WindowBounds | undefined {
  if (!saved || !workAreas.length) return;
  const overlap = (area: WindowBounds) => Math.max(0, Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x)) * Math.max(0, Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y));
  const area = [...workAreas].sort((a, b) => overlap(b) - overlap(a))[0]!;
  const width = Math.min(saved.width, Math.max(720, area.width)), height = Math.min(saved.height, Math.max(480, area.height));
  return { width, height, x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) };
}

/** Native normal bounds survive maximization; close flushes a pending move. */
export function trackWindowGeometry(window: BrowserWindow, store: WindowStateStore, changed: (status: { error?: string }) => void = () => {}): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => { clearTimeout(timer); timer = undefined; if (!window.isDestroyed()) changed(store.saveGeometry(window.getNormalBounds(), window.isMaximized())); };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(save, 250); };
  window.on("move", schedule); window.on("resize", schedule); window.on("maximize", schedule); window.on("unmaximize", schedule);
  window.on("close", save);
  window.on("closed", () => clearTimeout(timer));
}
