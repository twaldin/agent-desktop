// Renderer state and static-render contracts. These do not simulate provider
// success or claim an Electron/browser interaction acceptance run.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopBridge, OmpModelDefinitions, OmpModelDefinitionsSnapshot, OmpSessionControls, OmpSettingsSnapshot, SettingJson } from "@agent-desktop/shared";
import { modelDefinitionsCatalog } from "../../../host/src/omp-settings/model-definitions";
import { settingsCatalog } from "../../../host/src/omp-settings/schema";
import { NativeDefinitionEditor, NativeModelDefinitionsState, NativeSettingRow, NativeSettingsState, NativeValueField, definitionFieldSchema, filterNativeSettings, nativeSettingMatches, nativeSettingSeed, updateDefaultModelRole, DefaultModelSetting } from "./NativeSettings";
const catalog = settingsCatalog();
const descriptor = (path: string) => catalog.settings.find(item => item.path === path)!;
const snapshot = (revision = "initial"): OmpSettingsSnapshot => ({ revision, cwd: "/contract/project", entries: [{ path: "compaction.enabled", effective: true, global: true, configured: true, globalConfigured: true, projectConfigured: false, credential: false, origin: "global" }], sources: { globalPath: "/contract/agent/config.yml", projectWritePath: "/contract/project/.omp/config.yml", projectRead: "native-capability-merged", overlays: "native-process-configuration" }, mutationEffects: "new-sessions-read-updated-config" });
function bridge(overrides: Partial<DesktopBridge> = {}) {
  return { getModelDefinitions: async () => definitions(), setModelDefinitions: async () => definitions("saved").snapshot, getSettingsCatalog: async () => catalog, getSettings: async () => snapshot(), getSessionControls: async () => null as unknown as OmpSessionControls, getModelCapabilities: async () => [], getSettingOptions: async (path: string) => ({ path, options: [], source: "native-static" as const, extensionCoverage: "not-applicable" as const }), setSetting: async () => snapshot("saved"), setSessionControl: async () => null as unknown as OmpSessionControls, subscribe: () => () => {}, ...overrides };
}

describe("native settings UI contracts", () => {
  test("all 484 pinned descriptors have typed renderers and remain searchable including advanced/native-terminal settings", () => {
    const data = new NativeSettingsState(bridge(), "contract-host");
    data.catalog = catalog; data.snapshot = snapshot();
    expect(catalog.settings).toHaveLength(484);
    for (const item of catalog.settings) {
      const value = item.defaultValue === undefined ? nativeSettingSeed(item.schema) : item.defaultValue;
      expect(nativeSettingMatches(value, item.schema)).toBe(true);
      const markup = renderToStaticMarkup(<NativeSettingRow descriptor={item} data={data} scope="global" writable={true}/>);
      expect(markup).toContain(`data-setting-path="${item.path}"`);
      expect(markup).not.toContain("has no supported editor");
      expect(filterNativeSettings(catalog.settings, item.path, "unrelated-tab").some(found => found.path === item.path)).toBe(true);
    }
    expect(filterNativeSettings(catalog.settings, "", "all")).toHaveLength(484);
  });
  test("boolean rows expose a named switch while native details reveal matching paths and reset", () => {
    const data = new NativeSettingsState(bridge(), "contract-host"); data.snapshot = snapshot();
    const d = { ...descriptor("compaction.enabled"), condition: undefined };
    const render = (searching = false) => renderToStaticMarkup(<NativeSettingRow descriptor={d} state={snapshot().entries[0]} data={data} scope="global" writable searching={searching}/>);
    const idle = render();
    expect(idle).toContain('role="switch"'); expect(idle).toContain(`aria-label="${d.label}"`);
    expect(idle).toContain('aria-checked="true"'); expect(idle).not.toContain('type="checkbox"');
    expect(idle).toContain('<details class="native-setting-details">');
    expect(idle).not.toContain('>Save</button>'); expect(idle).not.toContain('>Discard edit</button>');
    const searched = render(true);
    expect(searched).toContain('<details class="native-setting-details" open="">');
    expect(searched).toContain('<dt>Setting path</dt><dd><code>compaction.enabled</code>');
    expect(searched).toContain('Reset to native default');
  });
  test("obsolete row opens saved-value comparison without losing its switch edit or discard", () => {
    const data = new NativeSettingsState(bridge(), "contract-host"); data.snapshot = snapshot();
    data.edit("global", "compaction.enabled", false); data.snapshot = snapshot("changed");
    const html = renderToStaticMarkup(<NativeSettingRow descriptor={descriptor("compaction.enabled")} state={snapshot().entries[0]} data={data} scope="global" writable/>);
    expect(html).toContain('aria-checked="false"'); expect(html).toContain('<details class="native-setting-details" open="">');
    expect(html).toContain('Saved: <code>true</code>'); expect(html).toContain('Use current revision for this edit');
    expect(html).toContain('<button class="primary-button" disabled="">Save</button>');
    expect(html).toContain('>Discard edit</button>');
  });
  test("compound fields expose maps, optional fields, arrays and type choices without a raw JSON-only editor", () => {
    const modelTags = renderToStaticMarkup(<NativeValueField schema={descriptor("modelTags").schema} value={{ fast: { name: "Fast", hidden: false } }} label="Model tags" onChange={() => {}}/>);
    expect(modelTags).toContain("Model tags fast name"); expect(modelTags).toContain("Color (optional)");
    expect(modelTags).toContain("Add entry"); expect(modelTags).toContain('type="checkbox"');
    const roles = renderToStaticMarkup(<NativeValueField schema={descriptor("modelRoles").schema} value={{ default: ["provider/first", "provider/second"] }} label="Model roles" onChange={() => {}}/>);
    expect(roles).toContain("value format"); expect(roles).toContain("Add item"); expect(roles).toContain("Move Model roles default item 2 up");
    const json = renderToStaticMarkup(<NativeValueField schema={{ kind: "json" }} value={{ any: [1, true] }} label="Native value" onChange={() => {}}/>);
    expect(json).toContain("no narrower upstream schema"); expect(json).toContain("value type");
  });
  test("credential values never render from snapshots and native reset semantics are explicit", () => {
    const d = descriptor("hindsight.apiToken");
    const data = new NativeSettingsState(bridge(), "contract-host"); data.snapshot = snapshot();
    const html = renderToStaticMarkup(<NativeSettingRow descriptor={d} scope="global" data={data} writable={true} state={{ path: d.path, effective: "contract-must-not-render", global: "contract-must-not-render", credential: true, configured: true, globalConfigured: true, projectConfigured: false, origin: "global" }}/>);
    expect(html).not.toContain("contract-must-not-render"); expect(html).toContain('type="password"'); expect(html).toContain("Write-only"); expect(html).toContain("Reset to native default");
  });
  test("a conflicting remote edit preserves local input and requires explicit rebase", async () => {
    let read = snapshot(); const requests: unknown[] = [];
    const data = new NativeSettingsState(bridge({ getSettings: async () => read, setSetting: async mutation => {
      requests.push(mutation);
      if (mutation.expectedRevision !== read.revision) throw new Error("OMP settings changed; reload before applying this edit");
      read = { ...read, revision: "saved" }; return read;
    } }), "remote", { projectId: "catalog-project" });
    await data.refresh(); data.edit("project", "compaction.enabled", false);
    read = { ...snapshot("remote-change"), entries: [] };
    await data.save("project", descriptor("compaction.enabled"));
    const edit = data.edits.get("project:compaction.enabled")!;
    expect(edit.value).toBe(false); expect(edit.revision).toBe("initial"); expect(edit.error).toContain("changed"); expect(data.snapshot?.revision).toBe("remote-change");
    const html = renderToStaticMarkup(<NativeSettingRow descriptor={descriptor("compaction.enabled")} scope="project" data={data} writable={true}/>);
    expect(html).toContain("Use current revision for this edit");
    data.rebase("project", "compaction.enabled"); await data.save("project", descriptor("compaction.enabled"));
    expect(data.edits.size).toBe(0); expect(requests).toHaveLength(2);
  });
  test("successful writes rebase only local edits from the same revision and preserve owner/scope", async () => {
    const calls: unknown[] = [];
    const data = new NativeSettingsState(bridge({ setSetting: async (mutation, target, host) => { calls.push({ mutation, target, host }); return snapshot("saved"); } }), "remote", { projectId: "project" });
    await data.refresh(); data.edit("global", "compaction.enabled", false); data.edit("project", "retry.enabled", false);
    await data.save("global", descriptor("compaction.enabled"));
    expect(data.edits.get("project:retry.enabled")?.revision).toBe("saved");
    expect(calls).toEqual([{ mutation: { expectedRevision: "initial", scope: "global", path: "compaction.enabled", operation: "set", value: false }, target: { projectId: "project" }, host: "remote" }]);
  });
  test("late reads cannot replace a completed write and unsaved secrets are not discarded on a failure", async () => {
    let reads = 0; const late = Promise.withResolvers<OmpSettingsSnapshot>();
    const data = new NativeSettingsState(bridge({ getSettings: async () => ++reads === 2 ? late.promise : snapshot(reads === 1 ? "initial" : "saved"), setSetting: async () => snapshot("saved") }), "remote");
    await data.refresh(); data.edit("global", "compaction.enabled", false);
    const refreshing = data.refresh(); await data.save("global", descriptor("compaction.enabled"));
    late.resolve(snapshot("stale-read")); await refreshing;
    expect(data.snapshot?.revision).toBe("saved");
    const secretData = new NativeSettingsState(bridge({ setSetting: async () => { throw new Error("Native validation rejected the edit"); } }), "remote");
    await secretData.refresh(); secretData.edit("global", "hindsight.apiToken", "contract-write-only-entry");
    await secretData.save("global", descriptor("hindsight.apiToken"));
    expect(secretData.edits.get("global:hindsight.apiToken")?.value).toBe("contract-write-only-entry");
    expect(secretData.edits.get("global:hindsight.apiToken")?.error).not.toContain("contract-write-only-entry");
    secretData.discard("global", "hindsight.apiToken"); expect(secretData.edits.size).toBe(0);
  });
  test("invalid values cannot be submitted and reset sends no credential value", async () => {
    const calls: unknown[] = [];
    const data = new NativeSettingsState(bridge({ setSetting: async mutation => { calls.push(mutation); return snapshot("saved"); } }), "remote");
    await data.refresh(); data.edit("global", "compaction.enabled", "false");
    await data.save("global", descriptor("compaction.enabled")); expect(calls).toEqual([]);
    expect(data.edits.get("global:compaction.enabled")?.error).toContain("valid boolean");
    await data.save("global", descriptor("hindsight.apiToken"), true);
    expect(calls).toEqual([{ expectedRevision: "initial", scope: "global", path: "hindsight.apiToken", operation: "reset" }]);
    expect(nativeSettingMatches(JSON.parse('{"__proto__":"bad"}') as SettingJson, { kind: "json" })).toBe(false);
  });
});

function definitions(revision = "initial"): OmpModelDefinitions {
  return { catalog: modelDefinitionsCatalog(), snapshot: { revision, sourcePath: "/contract/agent/models.yml", writePath: "/contract/agent/models.yml", format: "yml", application: "discovery-refresh-and-new-sessions", document: { providers: { custom: { api: "openai-completions", auth: "none", models: [{ id: "first", name: "First model", compat: { openRouterRouting: { only: ["a", "b"] }, whenThinking: { supportsReasoningEffort: true } }, thinking: { mode: "effort", efforts: ["low", "high"] } }, { id: "second", name: "Second model" }] } } }, concealed: [{ path: ["providers", "custom", "baseUrl"], configured: true }, { path: ["providers", "custom", "models", 0, "headers"], configured: true }, { path: ["providers", "custom", "models", 0, "compat", "extraBody"], configured: true }], unsupportedPaths: [] } };
}
describe("native model definition editor contracts", () => {
  test("derived native schema renders typed model, thinking, routing, conditional compat and write-only fields", async () => {
    const data = new NativeModelDefinitionsState(bridge(), "owning-host"); await data.refresh();
    data.begin(["providers", "custom", "models", 0]);
    const html = renderToStaticMarkup(<NativeDefinitionEditor data={data} writable={true} onSaved={() => {}}/>);
    expect(html).toContain("Open Router Routing"); expect(html).toContain("When Thinking"); expect(html).toContain("Efforts"); expect(html).toContain("Add item");
    expect(html).toContain("Saved value is concealed and retained"); expect(html).toContain("Replace saved value"); expect(html).toContain("Clear saved value");
    expect(html).not.toContain("has no supported editor");
    const schema = definitionFieldSchema(data.bundle!.catalog.schema, ["providers", "custom", "models", 0, "compat", "whenThinking", "extraBody"]);
    expect(schema.kind).toBe("map"); expect(schema.writeOnly).toBe(true);
    const privateEntry = renderToStaticMarkup(<NativeValueField schema={schema} value={{ private: "new-write-only-entry" }} label="Request body" onChange={() => {}}/>);
    expect(privateEntry).toContain('type="password"');
    const numeric = definitionFieldSchema(data.bundle!.catalog.schema, ["providers", "custom", "compat", "streamIdleTimeoutMs"]);
    expect(nativeSettingMatches(-1, numeric)).toBe(false); expect(nativeSettingMatches(0, numeric)).toBe(true);
  });
  test("model edit conflicts preserve local values and rebase by native id after another client reorders models", async () => {
    let current = definitions(); const calls: unknown[] = [];
    const data = new NativeModelDefinitionsState(bridge({ getModelDefinitions: async () => current, setModelDefinitions: async (mutation, hostId) => {
      calls.push({ mutation, hostId });
      if (mutation.expectedRevision !== current.snapshot.revision) throw new Error("Native model definitions changed");
      return { ...current.snapshot, revision: "saved" };
    } }), "remote-owner");
    await data.refresh(); data.begin(["providers", "custom", "models", 0]);
    data.change({ ...(data.edit!.value as object), name: "Unsaved local title" });
    current = definitions("other-client");
    const config = (current.snapshot.document.providers as any).custom;
    config.models.reverse(); current.snapshot.concealed = current.snapshot.concealed.map(field => ({ ...field, path: field.path[2] === "models" ? [...field.path.slice(0, 3), 1, ...field.path.slice(4)] : field.path }));
    expect(await data.save()).toBe(false);
    expect((data.edit?.value as any).name).toBe("Unsaved local title"); expect(data.edit?.revision).toBe("initial");
    data.rebase(); expect(data.edit?.path).toEqual(["providers", "custom", "models", 1]);
    expect(await data.save()).toBe(true); expect(data.edit).toBeNull();
    expect((calls[1] as any).hostId).toBe("remote-owner"); expect((calls[1] as any).mutation.changes[0].path).toEqual(["providers", "custom", "models", 1]);
  });
  test("explicit secret clearing precedes replacement while unrelated concealed values remain omitted", async () => {
    let mutation: any;
    const data = new NativeModelDefinitionsState(bridge({ setModelDefinitions: async value => { mutation = value; return definitions("saved").snapshot; } }), "owner");
    await data.refresh(); data.begin(["providers", "custom", "models", 0]);
    data.clear(["headers"]);
    data.change({ ...(data.edit!.value as object), headers: { Authorization: "contract-new-header" } });
    expect(await data.save()).toBe(true);
    expect(mutation.changes[0]).toEqual({ path: ["providers", "custom", "models", 0, "headers"], operation: "remove" });
    expect(mutation.changes[1].value.headers.Authorization).toBe("contract-new-header");
    expect(mutation.changes[1].value.compat.extraBody).toBeUndefined();
  });
  test("unsaved definitions block switching and stale reads cannot erase a completed mutation", async () => {
    let reads = 0; const pending = Promise.withResolvers<OmpModelDefinitions>();
    const data = new NativeModelDefinitionsState(bridge({ getModelDefinitions: async () => ++reads === 2 ? pending.promise : definitions(reads === 1 ? "initial" : "saved") }), "owner");
    await data.refresh(); data.begin(["providers", "custom", "models", 0]); data.change({ ...(data.edit!.value as object), name: "Local" });
    expect(data.begin(["providers", "custom", "models", 1])).toBe(false);
    const late = data.refresh(); expect(await data.save()).toBe(true); pending.resolve(definitions("stale")); await late;
    expect(data.bundle?.snapshot.revision).toBe("saved"); expect(data.edit).toBeNull();
  });
  test("a removed original model cannot be silently recreated at another array index", async () => {
    let current = definitions();
    const data = new NativeModelDefinitionsState(bridge({ getModelDefinitions: async () => current }), "owner");
    await data.refresh(); data.begin(["providers", "custom", "models", 0]); data.change({ ...(data.edit!.value as object), name: "Local" });
    current = definitions("removed"); (current.snapshot.document.providers as any).custom.models.shift(); await data.refresh(); data.rebase();
    expect(data.actionError).toContain("removed"); expect(data.edit?.revision).toBe("initial"); expect((data.edit?.value as any).name).toBe("Local");
  });
  test("duplicate-ID model edits submit the exact row and revision while reorder sends no ambiguous array", async () => {
    const current = definitions(); (current.snapshot.document.providers as any).custom.models[1].id = "first";
    const calls: any[] = [];
    const data = new NativeModelDefinitionsState(bridge({ getModelDefinitions: async () => current, setModelDefinitions: async mutation => { calls.push(mutation); return { ...current.snapshot, revision: "saved" }; } }), "owner");
    await data.refresh(); data.begin(["providers", "custom", "models", 1]);
    data.change({ ...(data.edit!.value as object), name: "Edited duplicate row" });
    expect(await data.save()).toBe(true);
    expect(calls).toEqual([{ expectedRevision: "initial", changes: [{ path: ["providers", "custom", "models", 1], operation: "set", value: { id: "first", name: "Edited duplicate row" } }] }]);
    expect(await data.reorder("custom", 1, -1)).toBe(false); expect(calls).toHaveLength(1);
    expect(data.actionError).toContain("Duplicate native model IDs prevent safe reordering");
  });
  test("duplicate IDs in the original or refreshed catalog prevent silent rebase to another row", async () => {
    for (const originalDuplicate of [true, false]) {
      let current = definitions();
      if (originalDuplicate) (current.snapshot.document.providers as any).custom.models[1].id = "first";
      const data = new NativeModelDefinitionsState(bridge({ getModelDefinitions: async () => current }), "owner");
      await data.refresh(); data.begin(["providers", "custom", "models", originalDuplicate ? 1 : 0]); data.change({ ...(data.edit!.value as object), name: "Retained local edit" });
      const originalPath = [...data.edit!.path];
      current = definitions("changed");
      if (!originalDuplicate) (current.snapshot.document.providers as any).custom.models[1].id = "first";
      await data.refresh(); data.rebase();
      expect(data.actionError).toContain("Duplicate native model IDs prevent safely locating");
      expect(data.edit?.revision).toBe("initial"); expect(data.edit?.path).toEqual(originalPath); expect((data.edit?.value as any).name).toBe("Retained local edit");
      expect(await data.save()).toBe(false);
    }
  });
});


describe("default model for new sessions", () => {
  test("updates only the default role and preserves aliases and ordered fallbacks", () => {
    const original = { default: ["old/primary", "old/fallback"], review: "review/model", plan: ["plan/one", "plan/two"] };
    expect(updateDefaultModelRole(original, "new/default")).toEqual({ default: "new/default", review: "review/model", plan: ["plan/one", "plan/two"] });
    expect(updateDefaultModelRole(original, undefined)).toEqual({ review: "review/model", plan: ["plan/one", "plan/two"] });
    expect(original.default).toEqual(["old/primary", "old/fallback"]);
  });
  test("shows unavailable and advanced saved defaults without changing the current session", () => {
    const data = new NativeSettingsState(bridge(), "host"); data.catalog = catalog;
    data.snapshot = { ...snapshot(), entries: [{ path: "modelRoles", credential: false, configured: true, globalConfigured: true, projectConfigured: false,
      global: { default: ["missing/first", "missing/second"], review: "review/model" }, effective: { default: ["missing/first", "missing/second"], review: "review/model" }, origin: "global" }] };
    data.models = [{ provider: "known", id: "model", api: "openai-completions", name: "Known model", contextWindow: 100000, maxTokens: 4096, input: ["text"], reasoning: false, supportsTools: true,
      thinkingSelectors: ["off"], serviceTierOptions: { openai: [], anthropic: [], google: [] }, capabilities: {}, compatibility: {}, settingsPaths: [], excludedSensitiveFields: [], unmappedCapabilityFields: [] }];
    const html = renderToStaticMarkup(<DefaultModelSetting data={data} scope="global" writable/>);
    expect(html).toContain("Advanced saved default"); expect(html).toContain("missing/first"); expect(html).toContain("Current sessions and account selection do not change");
  });
  test("preserves a pending complete role map and fences it when the host revision changes", () => {
    const data = new NativeSettingsState(bridge(), "host"); data.catalog = catalog;
    data.snapshot = { ...snapshot("before"), entries: [{ path: "modelRoles", credential: false, configured: true, globalConfigured: true, projectConfigured: false,
      global: { default: "old/default", review: "review/model" }, effective: { default: "old/default", review: "review/model" }, origin: "global" }] };
    data.edit("global", "modelRoles", { default: "new/default", review: "review/model", plan: ["plan/first", "plan/fallback"] });
    data.snapshot = { ...data.snapshot, revision: "after" };
    const html = renderToStaticMarkup(<DefaultModelSetting data={data} scope="global" writable/>);
    expect(html).toContain("saved settings changed");
    expect(html).toContain("Review current revision");
    expect(html).toContain("Save default");
    expect(data.edits.get("global:modelRoles")?.value).toEqual({ default: "new/default", review: "review/model", plan: ["plan/first", "plan/fallback"] });
  });
  test("rebases a default-only edit onto remote non-default role changes before retry", async () => {
    const writes: any[] = [];
    const entry = (revision: string, roles: SettingJson) => ({ ...snapshot(revision), entries: [{ path: "modelRoles", credential: false, configured: true, globalConfigured: true, projectConfigured: false, global: roles, effective: roles, origin: "global" as const }] });
    let remote = entry("r1", { default: "old/default", review: "review/old", plan: ["plan/first", "plan/fallback"] });
    const data = new NativeSettingsState(bridge({ getSettings: async () => remote, setSetting: async mutation => { writes.push(mutation); if (mutation.expectedRevision !== remote.revision) throw new Error("OMP settings changed"); remote = entry("r3", mutation.value!); return remote; } }), "host");
    await data.refresh(); data.editDefaultModel("global", "new/default");
    remote = entry("r2", { default: "old/default", review: "review/remote", plan: ["remote/first", "remote/fallback"] });
    await data.save("global", descriptor("modelRoles"));
    expect(data.edits.get("global:modelRoles")?.error).toContain("changed");
    await data.refresh();
    data.rebaseDefaultModel("global"); await data.save("global", descriptor("modelRoles"));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ expectedRevision: "r2", value: { default: "new/default", review: "review/remote", plan: ["remote/first", "remote/fallback"] } });
  });
  test("does not replace a separate advanced role-map edit from the dedicated selector", () => {
    const data = new NativeSettingsState(bridge(), "host"); data.snapshot = snapshot("r1");
    const advanced = { default: ["advanced/first", "advanced/fallback"], review: "advanced/review" };
    data.edit("global", "modelRoles", advanced); data.editDefaultModel("global", "new/default");
    expect(data.edits.get("global:modelRoles")?.value).toEqual(advanced);
    expect(data.edits.get("global:modelRoles")?.error).toContain("existing advanced model role edit");
  });
});
