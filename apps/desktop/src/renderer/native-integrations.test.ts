import { expect, test } from "bun:test";
import { applyCatalogResponse, mcpTransportLabel, pluginSettingDisabled } from "./NativeIntegrations";
import type { NativePlugin } from "@agent-desktop/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativePluginSummary } from "./NativePluginSummary";

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

test("native plugin metadata is escaped and only supported website targets become links", () => {
  const render = (metadata: Partial<NativePlugin>) => renderToStaticMarkup(createElement(NativePluginSummary,{plugin:{...plugin(true),...metadata},disabled:false,onToggle:()=>{},onOpenWebsite:()=>{}}));
  const html=render({category:'<native category>',homepage:'https://example.com/plugin?a=1&b=2'});
  expect(html).toContain('&lt;native category&gt;');
  expect(html).toContain('href="https://example.com/plugin?a=1&amp;b=2"');
  for(const homepage of ['http://example.com/plugin','https://user:pass@example.com/plugin','javascript:alert(1)','file:///tmp/plugin']) expect(render({homepage})).not.toContain('href=');
  expect(render({})).not.toContain('<dt>Category</dt>');
  expect(render({})).toContain('<dt>Website</dt><dd><span class="plugin-detail-unavailable">Unavailable</span>');
});
