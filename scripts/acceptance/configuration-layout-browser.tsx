import { createRoot } from "react-dom/client";
import type { DesktopBridge, DesktopEvent, HostState } from "../../packages/shared/src/protocol";
import type { OmpSettingDescriptor, OmpSettingsCatalog, OmpSettingsSnapshot } from "../../packages/shared/src/settings";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import { App } from "../../apps/desktop/src/renderer/App";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const source = { version: "18.1.10" as const, commit: "fixture-configuration-layout", file: "fixture-schema.ts" };
const setting = (value: Pick<OmpSettingDescriptor, "path" | "label" | "tab" | "group" | "advanced">): OmpSettingDescriptor => ({
  ...value, type: "boolean", description: `${value.label} fixture setting`, metadataSource: "schema-path", credential: false,
  defaultValue: false, schema: { kind: "boolean" }, control: "toggle", scopes: ["global", "project"],
  applicability: "native-runtime", application: "next-session", source,
});
const descriptors = [
  setting({ path: "appearance.fixtureEnabled", label: "Fixture enabled", tab: "appearance", group: "Display", advanced: false }),
  {
    ...setting({ path: "appearance.fixtureObject", label: "Fixture object", tab: "appearance", group: "Display", advanced: false }),
    type: "record" as const, control: "record" as const,
    defaultValue: { label: "saved", enabled: false },
    schema: { kind: "object" as const, fields: { label: { schema: { kind: "string" as const } }, enabled: { schema: { kind: "boolean" as const } } } },
  },
  setting({ path: "advanced.hiddenContract", label: "Advanced hidden contract", tab: "advanced", group: "Diagnostics", advanced: true }),
  setting({ path: "future.schemaOnly", label: "Future schema setting", tab: "future", group: "Lab", advanced: false }),
];
const catalog: OmpSettingsCatalog = {
  version: "18.1.10", sourceCommit: source.commit, settings: descriptors,
  groups: { all: ["Display", "Diagnostics", "Lab"], appearance: ["Display"], advanced: ["Diagnostics"] },
  tabs: [{ id: "appearance", label: "Appearance", icon: "settings" }, { id: "advanced", label: "Advanced", icon: "settings" }],
  extensionSettings: "not-in-core-schema",
};
let snapshot: OmpSettingsSnapshot = {
  revision: "settings-r1", cwd: "/fixture", entries: descriptors.map(descriptor => ({
    path: descriptor.path, effective: descriptor.defaultValue, global: descriptor.defaultValue, configured: true, globalConfigured: true,
    projectConfigured: false, credential: false, origin: "global" as const,
  })),
  sources: { globalPath: "/fixture/settings.json", projectWritePath: "/fixture/.omp/settings.json", projectRead: "native-capability-merged", overlays: "native-process-configuration" },
  mutationEffects: "new-sessions-read-updated-config",
};
const hostState: HostState = {
  protocolVersion: 1, host: { id: "home", name: "Fixture Mac", platform: "darwin", architecture: "arm64" },
  projects: [{ id: "project", hostId: "home", name: "Fixture project", path: "/fixture", createdAt: 1 }], sessions: [],
  drafts: [{ id: "new-conversation", projectId: "project", text: "", model: null, revision: 0, updatedAt: 1 }], models: [], lastEventSequence: 0,
};
const listeners = new Set<(event: DesktopEvent) => void>();
const settingWrites: unknown[] = [];
window.agentDesktopWindow = {
  initial: { state: { ...defaultWindowView(), settingsOpen: true, settingsPage: "omp", route: { sessionId: null }, expandedProjects: ["home:project"] } },
  save: () => ({}),
};
window.agentDesktop = new Proxy({} as DesktopBridge, { get: (_target, property) => {
  if (property === "subscribe") return (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); };
  if (String(property).startsWith("subscribe")) return () => {};
  if (property === "getState") return async () => hostState;
  if (property === "getHosts") return async () => ({ ownNodeId: "node-local", hosts: [] });
  if (property === "getSettingsCatalog") return async () => structuredClone(catalog);
  if (property === "getSettings") return async () => structuredClone(snapshot);
  if (property === "setSetting") return async (mutation: unknown) => { settingWrites.push(structuredClone(mutation)); return structuredClone(snapshot); };
  if (property === "getModelCapabilities") return async () => [];
  if (property === "getModelDefinitions") return async () => ({
    catalog: { version: "18.1.10", sourceCommit: source.commit, schema: { kind: "object", fields: {} }, sourceFile: "models.ts", validator: "native-models-config-schema-and-provider-validation", rules: [] },
    snapshot: { revision: "models-r1", sourcePath: "/fixture/models.yml", writePath: "/fixture/models.yml", format: "missing", document: {}, concealed: [], unsupportedPaths: [], application: "discovery-refresh-and-new-sessions" },
  });
  if (property === "getSshHosts") return async () => ({ revision: "ssh-r1", hosts: [], warnings: [] });
  if (property === "getComposerCatalog") return async () => ({ cwd: "/fixture", default: { model: null, source: "unavailable" }, models: [], resolution: "native-registry-preview" });
  if (property === "getPreferences") return async () => ({ version: 1, records: [] });
  if (property === "getLocalFonts") return async () => [];
  if (property === "applyWindowTheme") return async () => {};
  if (property === "getMessages") return async () => [];
  if (property === "command") return async () => ({ ok: true, commandId: "fixture", value: {} });
  if (["getBtw", "getBrowserMetadata", "createBrowserTab", "createTerminal", "subscribeNotificationNavigation"].includes(String(property))) return undefined;
  return async () => undefined;
} });

createRoot(document.getElementById("root")!).render(<App/>);
const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length);
const box = (node: Element | null) => { const value = node?.getBoundingClientRect(); return value && { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }; };
const row = (path: string) => {
  const root = document.querySelector<HTMLElement>(`[data-setting-path="${path}"]`), details = root?.querySelector<HTMLDetailsElement>(".native-setting-details");
  const pathTerm = [...(details?.querySelectorAll("dt") ?? [])].find(term => term.textContent?.trim() === "Setting path");
  const pathCode = pathTerm?.nextElementSibling?.querySelector("code");
  const save = [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(button => button.textContent?.trim().startsWith("Save"));
  const discard = [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(button => button.textContent?.trim() === "Discard edit");
  const reset = [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(button => button.textContent?.includes("Reset to native default"));
  return {
    main: box(root?.querySelector(".native-setting-main") ?? null), summary: box(root?.querySelector(".native-setting-summary") ?? null), controls: box(root?.querySelector(".native-setting-controls") ?? null), card: box(root?.closest(".native-settings-card") ?? null),
    compound: root?.classList.contains("native-setting-compound") ?? false, detailsOpen: details?.open ?? false,
    pathVisible: Boolean(details?.open && pathCode?.textContent === path && pathCode.getClientRects().length), save: save ? { disabled: save.disabled } : null, discard: Boolean(discard), reset: reset ? { visible: Boolean(details?.open && reset.getClientRects().length), disabled: reset.disabled } : null,
    alert: root?.querySelector<HTMLElement>(".native-edit-error")?.innerText ?? null,
    rebase: Boolean([...root?.querySelectorAll<HTMLButtonElement>("button") ?? []].find(button => button.textContent?.includes("Use current revision"))),
  };
};
Object.assign(window, { configurationLayoutState: () => {
  const column = document.querySelector<HTMLElement>(".native-settings-column")?.getBoundingClientRect();
  const page = document.querySelector<HTMLElement>(".native-settings")?.getBoundingClientRect();
  const scroll = document.querySelector<HTMLElement>(".native-settings-scroll");
  const category = document.querySelector<HTMLSelectElement>("[aria-label='Native settings category']");
  const scope = document.querySelector<HTMLSelectElement>("[aria-label='Native settings scope']");
  return {
    text: document.body.innerText, category: category?.value, categoryOptions: [...(category?.options ?? [])].map(option => ({ value: option.value, text: option.text })),
    scope: scope?.value, scopeVisible: !!scope?.getClientRects().length, settingWrites: structuredClone(settingWrites),
    checked: document.querySelector("[data-setting-path='appearance.fixtureEnabled'] [role='switch']")?.getAttribute("aria-checked") === "true",
    rows: { scalar: row("appearance.fixtureEnabled"), compound: row("appearance.fixtureObject"), advanced: row("advanced.hiddenContract") },
    advancedVisible: Boolean(document.querySelector<HTMLDetailsElement>("[data-setting-path='advanced.hiddenContract']")?.closest<HTMLDetailsElement>(".native-advanced")?.open),
    advancedOpen: document.querySelector<HTMLDetailsElement>(".native-advanced")?.open,
    outerSidebars: visible(".settings-sidebar").length, nestedSidebars: visible(".native-sidebar").length, legacyLayouts: visible(".native-layout").length,
    backButtons: visible("button").filter(node => node.textContent?.includes("Back to app")).length,
    headings: visible("h1").map(node => node.textContent?.trim()),
    structure: !!document.querySelector(".native-settings-scroll > .native-settings-column > .native-page-header") && !!document.querySelector(".native-settings-column > .native-toolbar") && !!document.querySelector(".native-settings-column > .native-content"),
    column: column && { left: column.left, right: column.right, width: column.width }, page: page && { left: page.left, right: page.right, width: page.width },
    viewport: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
    scroll: scroll && { clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth },
  };
}, configurationLayoutControl: (command: string) => {
  if (command !== "advance-settings-revision") throw new Error(`Unknown Configuration fixture command ${command}`);
  snapshot = { ...snapshot, revision: "settings-r2" };
  for (const listener of listeners) listener({ type: "settings", sequence: 2, hostId: "home", target: { projectId: "project" }, scope: "global" });
} });

declare global { interface Window { configurationLayoutState(): unknown; configurationLayoutControl(command: string): void } }
