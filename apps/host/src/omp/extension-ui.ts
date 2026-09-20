import { sanitizeStatusText } from "@oh-my-pi/pi-coding-agent/modes/shared";
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { NativeExtensionUiSnapshot } from "../../../../packages/shared/src/extension-ui";

/** Native keyed presentation survives renderer disconnects, never its owner. */
export class NativeExtensionUi {
  readonly epoch = crypto.randomUUID();
  #revision = 0;
  #disposed = false;
  #statuses = new Map<string, string>();
  #widgets = new Map<string, NativeExtensionUiSnapshot["widgets"][number]>();
  constructor(readonly sessionId: string, private changed: (epoch: string, revision: number) => void) {}
  #publish() { this.changed(this.epoch, ++this.#revision); }
  #assertActive() { if (this.#disposed) throw new Error("The original extension UI owner is disposed."); }
  setStatus(key: string, text: string | undefined): void {
    this.#assertActive();
    if (typeof key !== "string" || text !== undefined && typeof text !== "string") throw new Error("Invalid extension status.");
    if (text === undefined) { if (!this.#statuses.delete(key)) return; }
    else { if (this.#statuses.get(key) === text && this.#statuses.has(key)) return; this.#statuses.set(key, text); }
    this.#publish();
  }
  setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
    this.#assertActive();
    if (typeof key !== "string" || content !== undefined && (!Array.isArray(content) || content.some(line => typeof line !== "string"))) throw new Error("Only native text widgets are supported.");
    const placement = options?.placement ?? "aboveEditor";
    if (placement !== "aboveEditor" && placement !== "belowEditor") throw new Error("Invalid native widget placement.");
    this.#widgets.delete(key);
    if (content !== undefined) this.#widgets.set(key, { key, lines: content.slice(0, 10), placement, truncated: content.length > 10 });
    this.#publish();
  }
  snapshot(): NativeExtensionUiSnapshot {
    this.#assertActive();
    return { sessionId: this.sessionId, epoch: this.epoch, revision: this.#revision,
      statuses: [...this.#statuses].sort(([a], [b]) => a.localeCompare(b)).map(([key, text]) => ({ key, text: sanitizeStatusText(text) })),
      widgets: structuredClone([...this.#widgets.values()]) };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const hadPresentation = this.#statuses.size > 0 || this.#widgets.size > 0;
    this.#statuses.clear(); this.#widgets.clear(); if (hadPresentation) this.#publish();
  }
}
