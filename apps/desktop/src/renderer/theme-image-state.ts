import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { ThemeAsset } from "../../../../packages/shared/src/theme";

type ImageBridge = Pick<DesktopBridge, "getThemeBackground">;
export class ThemeImageState {
  sha256?: string;
  asset?: ThemeAsset;
  dataUrl?: string;
  status: "none" | "loading" | "ready" | "unavailable" | "error" = "none";
  error?: string;
  private epoch = 0;
  private pending?: { id: string; promise: Promise<void> };
  private again = false;
  private listeners = new Set<() => void>();
  constructor(private bridge: ImageBridge, private decode: (url: string) => Promise<void> = decodeImage) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  select(sha256?: string) {
    if (sha256 === this.sha256) return;
    this.epoch++; this.sha256 = sha256; this.asset = undefined; this.dataUrl = undefined; this.error = undefined;
    this.status = sha256 ? "loading" : "none"; this.changed();
    if (sha256) void this.refresh();
  }
  refresh(): Promise<void> {
    const id = this.sha256; if (!id) return Promise.resolve();
    if (this.status === "ready" && this.dataUrl) return Promise.resolve();
    if (this.pending?.id === id) { this.again = true; return this.pending.promise; }
    const epoch = this.epoch;
    this.status = this.dataUrl ? "ready" : "loading"; this.error = undefined; this.changed();
    const promise = (async () => {
      try {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("The saved image does not have a valid SHA-256 identifier.");
        const value = await this.bridge.getThemeBackground(id);
        if (epoch !== this.epoch) return;
        if (!value) { this.status = "unavailable"; this.error = "This image has not reached this device. Its saved hash is retained; a connected app host can supply it."; return; }
        if (value.asset.sha256 !== id || !["image/png", "image/jpeg", "image/webp"].includes(value.asset.mimeType) || value.asset.bytes <= 0 || value.asset.bytes > 20 * 1024 * 1024 || !value.dataUrl.startsWith(`data:${value.asset.mimeType};base64,`) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataUrl.slice(value.dataUrl.indexOf(",") + 1))) throw new Error("The host returned an invalid background image payload.");
        await this.decode(value.dataUrl);
        if (epoch !== this.epoch) return;
        this.asset = value.asset; this.dataUrl = value.dataUrl; this.status = "ready";
      } catch (cause) { if (epoch === this.epoch) { this.error = cause instanceof Error ? cause.message : String(cause); this.status = "error"; } }
      finally { if (epoch === this.epoch) this.changed(); }
    })().finally(async () => { if (this.pending?.promise === promise) { this.pending = undefined; if (this.again) { this.again = false; await this.refresh(); } } });
    this.pending = { id, promise }; return promise;
  }
}
async function decodeImage(url: string) { const image = new Image(); image.src = url; try { await image.decode(); } catch { throw new Error("This device could not decode the saved background image. Its hash and theme settings are retained."); } }
