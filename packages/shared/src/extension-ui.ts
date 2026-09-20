/** Ephemeral presentation from one existing native extension UI owner. */
export const EXTENSION_UI_OWNER_HEADER = "x-agent-desktop-extension-ui-owner";
export type ExtensionWidgetPlacement = "aboveEditor" | "belowEditor";
export interface NativeExtensionUiSnapshot {
  sessionId: string;
  epoch: string;
  revision: number;
  statuses: Array<{ key: string; text: string }>;
  widgets: Array<{ key: string; lines: string[]; placement: ExtensionWidgetPlacement; truncated: boolean }>;
}
export type ExtensionUiResult = { protocolVersion: 1; hostId: string; sessionId: string } & (
  | { availability: "available"; value: NativeExtensionUiSnapshot }
  | { availability: "unavailable"; reason: string }
);
export function parseNativeExtensionUiSnapshot(input: unknown): NativeExtensionUiSnapshot {
  if (!input || typeof input !== "object") throw new Error("Invalid native extension display.");
  const value = input as NativeExtensionUiSnapshot;
  if (typeof value.sessionId !== "string" || !value.sessionId || typeof value.epoch !== "string" || !value.epoch
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.statuses) || !Array.isArray(value.widgets)) throw new Error("Invalid native extension owner.");
  const statusKeys = new Set<string>(), widgetKeys = new Set<string>();
  for (const item of value.statuses) {
    if (!item || typeof item.key !== "string" || typeof item.text !== "string" || statusKeys.has(item.key)) throw new Error("Invalid native extension status.");
    statusKeys.add(item.key);
  }
  for (const item of value.widgets) {
    if (!item || typeof item.key !== "string" || widgetKeys.has(item.key) || !Array.isArray(item.lines) || item.lines.length > 10
      || item.lines.some(line => typeof line !== "string") || !["aboveEditor", "belowEditor"].includes(item.placement) || typeof item.truncated !== "boolean") throw new Error("Invalid native extension widget.");
    widgetKeys.add(item.key);
  }
  return structuredClone(value);
}
export function parseExtensionUiResult(input: unknown, hostId: string, sessionId: string): ExtensionUiResult {
  if (!input || typeof input !== "object") throw new Error("Invalid extension display response.");
  const value = input as ExtensionUiResult;
  if (value.protocolVersion !== 1 || value.hostId !== hostId || value.sessionId !== sessionId) throw new Error("Extension display belongs to a different owner.");
  if (value.availability === "available") {
    const snapshot = parseNativeExtensionUiSnapshot(value.value);
    if (snapshot.sessionId !== sessionId) throw new Error("Native extension session changed.");
    return { ...value, value: snapshot };
  }
  if (value.availability !== "unavailable" || typeof value.reason !== "string" || !value.reason) throw new Error("Invalid extension display availability.");
  return value;
}
