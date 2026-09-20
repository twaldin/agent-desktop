import { NativeExtensionUi } from "./extension-ui";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionFactory, ExtensionUIContext, ExtensionUIDialogOptions, ExtensionUISelectItem, ExtensionWidgetContent, ExtensionWidgetOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

import type { OmpInteraction, OmpInteractionResponse, InteractionEndReason, OmpBridgeEvent } from "@agent-desktop/shared";
export type { InteractionMethod, InteractionAction, OmpInteraction, OmpInteractionResponse, InteractionEndReason, OmpBridgeEvent } from "@agent-desktop/shared";

export class UnsupportedOmpUIError extends Error {
  constructor(readonly surface: string) {
    super(`Native OMP UI surface '${surface}' is not supported by the desktop interaction bridge`);
    this.name = "UnsupportedOmpUIError";
  }
}

/** Correlates the native approval hook with exactly one immediately following UI request. */
export function nativeApprovalInteractionClassification(getBridge: () => OmpInteractionBridge | undefined): ExtensionFactory {
  const markers = new Map<string, () => void>();
  return pi => {
    pi.on("tool_approval_requested", event => {
      markers.get(event.toolCallId)?.();
      const bridge = getBridge();
      if (bridge) markers.set(event.toolCallId, bridge.markNextInteractionAsPermission());
    });
    pi.on("tool_approval_resolved", event => {
      markers.get(event.toolCallId)?.(); markers.delete(event.toolCallId);
    });
  };
}

interface Pending {
  request: OmpInteraction;
  options?: ExtensionUIDialogOptions;
  finish(value: string | boolean | undefined, reason: InteractionEndReason): void;
  resetTimeout(): void;
}

interface DecisionBindingScope {
  active: boolean;
  calls: number;
  bind(interactionId: string): Promise<void>;
  error?: Error;
  invalidate?: (error: Error) => void;
}

/** Only serializable requests cross the process boundary; callbacks remain here. */
export class OmpInteractionBridge implements ExtensionUIContext {
  readonly timeoutStartsOnPresentation = false;
  #pending = new Map<string, Pending>();
  #permissionMarkers: symbol[] = [];
  #callSignal = new AsyncLocalStorage<AbortSignal>();
  #decisionBinding = new AsyncLocalStorage<DecisionBindingScope>();
  #cancellationGeneration = 0;

  runWithSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return this.#callSignal.run(signal, work);
  }
  async runWithDecisionBinding<T>(bind: (interactionId: string) => Promise<void>, selectNative: () => Promise<T>): Promise<T> {
    const scope: DecisionBindingScope = { active: true, calls: 0, bind };
    try {
      try {
        const result = await this.#decisionBinding.run(scope, selectNative);
        if (scope.calls !== 1) throw scope.error ?? new Error("Native reset decision must create exactly one select interaction");
        if (scope.invalidate) {
          const error = scope.error ??= new Error("Native reset decision must await its select interaction");
          scope.invalidate(error);
          throw error;
        }
        return result;
      } catch (error) {
        if (scope.calls !== 1) throw scope.error ?? new Error("Native reset decision must create exactly one select interaction");
        throw error;
      }
    } finally {
      scope.active = false;
    }
  }
  #disposed = false;
  readonly presentation: NativeExtensionUi;
  constructor(readonly sessionId: string, private emit: (event: OmpBridgeEvent) => void) {
    this.presentation = new NativeExtensionUi(sessionId, (epoch, revision) => emit({ type: "extension_ui_changed", sessionId, epoch, revision }));
  }

  list(): OmpInteraction[] { return structuredClone([...this.#pending.values()].map(item => item.request)); }

  /** Scope the immediately following native UI request to an explicit approval hook. */
  markNextInteractionAsPermission(): () => void {
    const marker = Symbol("native-approval");
    this.#permissionMarkers.push(marker);
    return () => {
      const index = this.#permissionMarkers.indexOf(marker);
      if (index !== -1) this.#permissionMarkers.splice(index, 1);
    };
  }

  permissionConfirm(title: string, message: string, options?: ExtensionUIDialogOptions): Promise<boolean> {
    const clear = this.markNextInteractionAsPermission();
    try { return this.confirm(title, message, options); }
    finally { clear(); }
  }

  #request(fields: Omit<OmpInteraction, "id" | "sessionId" | "createdAt" | "actions">, options?: ExtensionUIDialogOptions): Promise<string | boolean | undefined> {
    const decision = this.#decisionBinding.getStore();
    if (decision) {
      if (!decision.active || fields.method !== "select" || ++decision.calls !== 1) {
        const error = decision.error ??= new Error("Native reset decision must create exactly one select interaction");
        decision.invalidate?.(error);
        return Promise.reject(error);
      }
      return this.#requestBound(fields, options, decision);
    }
    return this.#publish(fields, options);
  }

  async #requestBound(fields: Omit<OmpInteraction, "id" | "sessionId" | "createdAt" | "actions">, options: ExtensionUIDialogOptions | undefined, scope: DecisionBindingScope): Promise<string | boolean | undefined> {
    const scopedSignal = this.#callSignal.getStore();
    if (this.#disposed) throw new Error("OMP interaction bridge is disposed");
    if (scopedSignal?.aborted || options?.signal?.aborted) return undefined;
    if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0 || options.timeout > 2_147_483_647)) {
      throw new Error("Invalid native interaction timeout");
    }
    const id = crypto.randomUUID();
    const generation = this.#cancellationGeneration;
    let invalidate!: (error: Error) => void;
    const invalidated = new Promise<never>((_, reject) => { invalidate = reject; });
    void invalidated.catch(() => {});
    scope.invalidate = invalidate;
    try {
      await Promise.race([scope.bind(id), invalidated]);
    } finally {
      if (scope.invalidate === invalidate) scope.invalidate = undefined;
    }
    if (scope.error) throw scope.error;
    if (!scope.active || this.#disposed || generation !== this.#cancellationGeneration || scopedSignal?.aborted || options?.signal?.aborted) {
      return undefined;
    }
    return this.#publish(fields, options, id, scope);
  }

  #publish(fields: Omit<OmpInteraction, "id" | "sessionId" | "createdAt" | "actions">, options?: ExtensionUIDialogOptions, id = crypto.randomUUID(), decision?: DecisionBindingScope): Promise<string | boolean | undefined> {
    const scopedSignal = this.#callSignal.getStore();
    if (scopedSignal) options = { ...options, signal: options?.signal ? AbortSignal.any([scopedSignal, options.signal]) : scopedSignal };
    if (this.#disposed) return Promise.reject(new Error("OMP interaction bridge is disposed"));
    const cancelled = fields.method === "confirm" ? false : undefined;
    if (options?.signal?.aborted) return Promise.resolve(cancelled);
    if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0 || options.timeout > 2_147_483_647)) {
      return Promise.reject(new Error("Invalid native interaction timeout"));
    }
    const request: OmpInteraction = {
      ...fields, id, sessionId: this.sessionId, createdAt: Date.now(), actions: [],
      ...(this.#permissionMarkers.shift() ? { notificationKind: "permission" as const } : {}),
      ...(options?.initialIndex === undefined ? {} : { initialIndex: options.initialIndex }),
      ...(options?.outline === undefined ? {} : { outline: options.outline }),
      ...(options?.helpText === undefined ? {} : { helpText: options.helpText }),
      ...(options?.selectionMarker === undefined ? {} : { selectionMarker: options.selectionMarker }),
      ...(options?.checkedIndices === undefined ? {} : { checkedIndices: [...options.checkedIndices] }),
      ...(options?.markableCount === undefined ? {} : { markableCount: options.markableCount }),
    };
    if (options?.onLeft) request.actions.push("left");
    if (options?.onRight) request.actions.push("right");
    if (options?.onExternalEditor) request.actions.push("externalEditor");
    if (options?.timeout !== undefined) request.actions.push("timeoutReset");
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let invalidate: ((error: Error) => void) | undefined;
      const clearDecision = () => { if (decision && decision.invalidate === invalidate) decision.invalidate = undefined; };
      const abort = () => finish(cancelled, "aborted");
      const finish = (value: string | boolean | undefined, reason: InteractionEndReason) => {
        if (!this.#pending.delete(request.id)) return;
        clearTimeout(timer); clearDecision();
        options?.signal?.removeEventListener("abort", abort);
        try {
          this.emit({ type: "extension_interaction_resolved", sessionId: this.sessionId, id: request.id, reason });
          if (reason === "timeout") options?.onTimeout?.();
          // Never retain the returned answer in a bridge event or snapshot.
          resolve(value);
        } catch (error) { reject(error); }
      };
      const resetTimeout = () => {
        clearTimeout(timer);
        if (options?.timeout === undefined) return;
        request.expiresAt = Date.now() + options.timeout;
        timer = setTimeout(() => finish(cancelled, "timeout"), options.timeout);
        timer.unref();
      };
      invalidate = error => {
        if (!this.#pending.delete(request.id)) return;
        clearTimeout(timer); clearDecision();
        options?.signal?.removeEventListener("abort", abort);
        try { this.emit({ type: "extension_interaction_resolved", sessionId: this.sessionId, id: request.id, reason: "cancelled" }); }
        catch { /* Scope invalidation remains the caller-visible failure. */ }
        reject(error);
      };
      if (decision) decision.invalidate = invalidate;
      this.#pending.set(request.id, { request, options, finish, resetTimeout });
      options?.signal?.addEventListener("abort", abort, { once: true });
      try {
        resetTimeout();
        this.emit({ type: "extension_interaction_requested", interaction: structuredClone(request) });
        if (options?.timeout !== undefined) options.onTimeoutStart?.();
      } catch (error) {
        this.#pending.delete(request.id); clearTimeout(timer); clearDecision();
        options?.signal?.removeEventListener("abort", abort); reject(error);
      }
    });
  }

  respond(id: string, response: OmpInteractionResponse): void {
    const item = this.#pending.get(id);
    if (!item) throw new Error("OMP interaction is no longer pending");
    if (!response || typeof response !== "object") throw new Error("Invalid OMP interaction response");
    if ("cancel" in response && response.cancel === true && Object.keys(response).length === 1) {
      item.finish(item.request.method === "confirm" ? false : undefined, "cancelled"); return;
    }
    if ("action" in response && Object.keys(response).length === 1) {
      if (!item.request.actions.includes(response.action)) throw new Error("Unsupported action for this OMP interaction");
      if (response.action === "left" || response.action === "right") {
        if (response.action === "left") item.options?.onLeft?.();
        else item.options?.onRight?.();
        // Native showHookSelector invokes the navigation callback and settles
        // undefined; ask uses that pair to move to another question.
        item.finish(item.request.method === "confirm" ? false : undefined, "navigated");
      }
      if (response.action === "externalEditor") item.options?.onExternalEditor?.();
      if (response.action === "timeoutReset") {
        item.resetTimeout(); item.options?.onTimeoutReset?.();
        if (this.#pending.has(id)) this.emit({ type: "extension_interaction_requested", interaction: structuredClone(item.request) });
      }
      return;
    }
    if (!("value" in response) || Object.keys(response).length !== 1) throw new Error("Invalid OMP interaction response");
    if (item.request.method === "confirm" ? typeof response.value !== "boolean" : typeof response.value !== "string") {
      throw new Error("Wrong value type for OMP interaction");
    }
    if (item.request.method === "select" && !item.request.options?.some(option => option.label === response.value)) {
      throw new Error("The selected value is not a native OMP option");
    }
    item.finish(response.value, "answered");
  }

  cancelAll(reason: Exclude<InteractionEndReason, "answered" | "navigated" | "timeout"> = "cancelled"): void {
    this.#cancellationGeneration++;
    for (const item of [...this.#pending.values()]) item.finish(item.request.method === "confirm" ? false : undefined, reason);
  }
  dispose(): void { this.#disposed = true; this.presentation.dispose(); this.cancelAll("disposed"); }
  select(title: string, options: ExtensionUISelectItem[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.#request({ method: "select", title, options: options.map(option => typeof option === "string" ? { label: option } : { label: option.label, ...(option.description === undefined ? {} : { description: option.description }) }) }, dialogOptions) as Promise<string | undefined>;
  }
  confirm(title: string, message: string, options?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.#request({ method: "confirm", title, message }, options) as Promise<boolean>;
  }
  input(title: string, placeholder?: string, options?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.#request({ method: "input", title, placeholder }, options) as Promise<string | undefined>;
  }
  editor(title: string, prefill?: string, options?: ExtensionUIDialogOptions, editorOptions?: { promptStyle?: boolean }): Promise<string | undefined> {
    return this.#request({ method: "editor", title, prefill, promptStyle: editorOptions?.promptStyle }, options) as Promise<string | undefined>;
  }
  notify(message: string, level: "info" | "warning" | "error" = "info"): void {
    this.emit({ type: "extension_notification", sessionId: this.sessionId, message, level });
  }

  unsupported(surface: string): never {
    const error = new UnsupportedOmpUIError(surface);
    this.emit({ type: "extension_ui_unsupported", sessionId: this.sessionId, surface, message: error.message });
    throw error;
  }
  // No factories are called and no success is fabricated for absent TUI/composer surfaces.
  onTerminalInput(): never { return this.unsupported("onTerminalInput"); }
  setStatus(key: string, text: string | undefined): void { this.presentation.setStatus(key, text); }
  setWorkingMessage(): never { return this.unsupported("setWorkingMessage"); }
  setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
    if (this.#disposed) throw new Error("The original extension UI owner is disposed.");
    if (typeof content === "function") return this.unsupported("setWidget(component factory)");
    this.presentation.setWidget(key, content, options);
  }
  setFooter(): never { return this.unsupported("setFooter"); }
  setHeader(): never { return this.unsupported("setHeader"); }
  setTitle(): never { return this.unsupported("setTitle"); }
  async custom<T>(): Promise<T> { return this.unsupported("custom"); }
  setEditorText(): never { return this.unsupported("setEditorText"); }
  pasteToEditor(): never { return this.unsupported("pasteToEditor"); }
  getEditorText(): never { return this.unsupported("getEditorText"); }
  addAutocompleteProvider(): never { return this.unsupported("addAutocompleteProvider"); }
  setEditorComponent(): never { return this.unsupported("setEditorComponent"); }
  get theme(): never { return this.unsupported("theme"); }
  async getAllThemes(): Promise<never> { return this.unsupported("getAllThemes"); }
  async getTheme(): Promise<never> { return this.unsupported("getTheme"); }
  async setTheme(): Promise<never> { return this.unsupported("setTheme"); }
  getToolsExpanded(): never { return this.unsupported("getToolsExpanded"); }
  setToolsExpanded(): never { return this.unsupported("setToolsExpanded"); }
}
