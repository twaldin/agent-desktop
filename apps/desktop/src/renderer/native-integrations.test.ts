import { expect, test } from "bun:test";
import { applyCatalogResponse, mcpTransportLabel, pluginSettingDisabled } from "./NativeIntegrations";
import type { NativePlugin } from "@agent-desktop/shared";

const plugin = (canSetSettings: boolean): NativePlugin => ({ id: "p", name: "p", title: "Plugin", version: "1", scope: "user", kind: "package", enabled: true, canToggle: true, canSetFeatures: true, canSetSettings, features: [], enabledFeatures: null, settings: [] });

test("plugin settings are disabled when the native catalog marks them read-only", () => {
  expect(pluginSettingDisabled(plugin(false), true, false)).toBe(true);
  expect(pluginSettingDisabled(plugin(true), true, false)).toBe(false);
  expect(pluginSettingDisabled(plugin(true), false, false)).toBe(true);
});

test("late catalog responses cannot replace a newer target epoch", () => {
  const newer = { revision: "new" };
  expect(applyCatalogResponse(3, 2, { revision: "old" })).toBeUndefined();
  expect(applyCatalogResponse(3, 3, newer)).toBe(newer);
});

test("unknown native MCP transports remain visible as unsupported labels", () => {
  expect(mcpTransportLabel("stdio")).toBe("stdio");
  expect(mcpTransportLabel("future")).toBe("Unknown transport");
  expect(mcpTransportLabel(undefined)).toBe("Unknown transport");
});
