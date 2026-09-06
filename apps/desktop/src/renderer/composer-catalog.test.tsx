// Controlled transport/state and static markup contracts, not provider or installed UI acceptance.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopBridge, DesktopEvent, Draft, OmpComposerCatalog, OmpComposerModel, OmpSessionControls, SessionSummary } from "@agent-desktop/shared";
import { ComposerCatalogState, composerSelection } from "./composer-catalog";
import { ComposerSelections } from "./ComposerSelections";
import { DraftController } from "./drafts";
import { SubmissionController } from "./submissions";

const model = (id = "first"): OmpComposerModel => ({ id, provider: "contract", name: `Model ${id}`, reasoning: true, input: ["text"], contextWindow: 100, maxTokens: 50, authenticated: true, available: true, thinkingLevels: ["auto", "off", "low", "high"], defaultThinkingLevel: "high", effectiveDefaultThinkingLevel: "high" });
const catalog = (id = "first"): OmpComposerCatalog => ({ cwd: `/contract/${id}`, models: [model("first"), model("second")], default: { model: model(id), thinkingLevel: "high", effectiveThinkingLevel: "high", source: "configured-role" }, resolution: "native-registry-preview" });
const session = (id = "first"): SessionSummary => ({ id: "session", hostId: "owner", projectId: "project", cwd: "/contract/project", title: "Contract session", status: "idle", sessionFile: "/contract/session.jsonl", model: { provider: "contract", id }, createdAt: 1, updatedAt: 1, archived: false });
const controls = (id = "first"): OmpSessionControls => ({ revision: id, sessionId: "session", model: { provider: "contract", id }, thinkingLevel: "low", serviceTiers: {}, capabilities: null, settings: [], overrides: [], runtimeMutablePaths: [], persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose" });
const draft = (patch: Partial<Draft> = {}): Draft => ({ id: "session:session", revision: 1, text: "Saved text", projectId: "project", model: null, updatedAt: 1, ...patch });
function fixture(overrides: Partial<Pick<DesktopBridge, "getComposerCatalog" | "getSessionControls">> = {}) {
  const listeners = new Set<(event: DesktopEvent) => void>();
  return {
    getComposerCatalog: async () => catalog(), getSessionControls: async () => controls(), ...overrides,
    subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit: (event: DesktopEvent) => { for (const listener of listeners) listener(event); },
  };
}

describe("owning-workspace composer selection", () => {
  test("project catalog requests carry only their owning host and catalog target", async () => {
    const calls: unknown[] = [];
    const bridge = fixture({ getComposerCatalog: async (target, refresh, hostId) => { calls.push({ target, refresh, hostId }); return catalog("second"); } });
    const data = new ComposerCatalogState(bridge, "owner", { projectId: "project" });
    data.start("local"); data.setConnected(true); await data.refresh();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => (call as any).hostId === "owner" && (call as any).target.projectId === "project")).toBe(true);
    expect(composerSelection(draft({ model: null }), data.catalog).model?.id).toBe("second");
    data.stop();
  });
  test("a native default model exposes its resolved reasoning without writing a draft override", async () => {
    const data = new ComposerCatalogState(fixture(), "owner"); data.setConnected(true); await data.refresh();
    const saved = draft({ id: "new-conversation", model: null });
    const html = renderToStaticMarkup(<ComposerSelections data={data} draft={saved} disabled={false} onChange={() => {}}/>);
    expect(html).toContain('aria-label="Model and reasoning effort"'); expect(html).toContain("Model first");
    expect(saved.model).toBeNull(); expect(saved.thinkingLevel).toBeUndefined(); data.stop();
  });
  test("Settings changes refresh current session controls without replacing an explicit or legacy draft selection", async () => {
    let native = controls(); const bridge = fixture({ getSessionControls: async () => native });
    const data = new ComposerCatalogState(bridge, "owner", { sessionId: "session" });
    data.start("local"); data.setConnected(true); await data.refresh();
    const following = draft(), explicit = draft({ model: { provider: "contract", id: "first" }, thinkingLevel: "high" });
    native = controls("second"); bridge.emit({ type: "settings", hostId: "owner", sequence: 1, sessionId: "session" }); await data.refresh();
    expect(composerSelection(following, data.catalog, session(), data.controls)).toMatchObject({ model: { id: "second" }, defaultThinking: "low", differingDraftModel: false });
    expect(composerSelection(explicit, data.catalog, session(), data.controls)).toMatchObject({ model: { id: "first" }, thinking: "high", differingDraftModel: true });
    expect(explicit.model?.id).toBe("first");
    const html = renderToStaticMarkup(<ComposerSelections data={data} draft={explicit} session={session()} disabled={false} onChange={() => {}}/>);
    expect(html).toContain("Model first high"); expect(html).toContain('aria-haspopup="menu"');
    expect(explicit.model).toEqual({ provider: "contract", id: "first" });
    data.stop();
  });
  test("loaded session capabilities and an explicit no-model result outrank newer catalog or stale summary data", () => {
    const native = { ...controls(), capabilities: { reasoning: false, thinkingSelectors: ["off"] } } as OmpSessionControls;
    expect(composerSelection(draft(), catalog(), session(), native)).toMatchObject({ reasoning: false, levels: ["off"] });
    expect(composerSelection(draft(), catalog(), session(), { ...controls(), model: null }).model).toBeNull();
  });
  test("older-host capabilities keep current session controls usable and new-chat defaults explicitly unresolved", async () => {
    const { authenticated: _auth, available: _available, ...legacyModel } = model();
    const legacy: OmpComposerCatalog = { cwd: null, models: [legacyModel], resolution: "legacy-capabilities", default: { model: null, source: "unknown-older-host" } };
    const data = new ComposerCatalogState(fixture({ getComposerCatalog: async () => legacy }), "owner", { sessionId: "session" });
    data.setConnected(true); await data.refresh();
    expect(data.error).toBeUndefined();
    const existing = renderToStaticMarkup(<ComposerSelections data={data} draft={draft()} session={session()} disabled={false} onChange={() => {}}/>);
    expect(existing).toContain("Model first"); expect(existing).toContain('aria-label="Model and reasoning effort"');
    const explicit = renderToStaticMarkup(<ComposerSelections data={data} draft={draft({ model: { provider: "contract", id: "first" } })} session={session()} disabled={false} onChange={() => {}}/>);
    expect(explicit).toContain("Model first"); expect(explicit).not.toContain("sign-in required");
    const home = renderToStaticMarkup(<ComposerSelections data={data} draft={draft()} disabled={false} onChange={() => {}}/>);
    expect(home).toContain("Native default (older host; unresolved)");
    expect(home).not.toContain('aria-label="Reasoning effort"');
    data.stop();
  });
  test("newer native invalidation wins over an in-flight metadata read, and other hosts do not refresh it", async () => {
    const late = Promise.withResolvers<OmpComposerCatalog>(); let calls = 0;
    const bridge = fixture({ getComposerCatalog: async () => ++calls === 1 ? late.promise : catalog("second") });
    const data = new ComposerCatalogState(bridge, "owner", { projectId: "project" }); data.start("local"); data.setConnected(true);
    bridge.emit({ type: "settings", hostId: "other", sequence: 1 }); expect(calls).toBe(1);
    bridge.emit({ type: "settings", hostId: "owner", sequence: 2, scope: "project", target: { projectId: "project" } });
    late.resolve(catalog("first")); await data.refresh();
    expect(data.catalog?.default.model?.id).toBe("second"); expect(calls).toBe(2); data.stop();
  });
  test("unmounted or disconnected owners cannot accept late metadata, and failures preserve saved choices", async () => {
    const late = Promise.withResolvers<OmpComposerCatalog>();
    const data = new ComposerCatalogState(fixture({ getComposerCatalog: () => late.promise }), "owner", { projectId: "old-project" });
    data.setConnected(true); const pending = data.refresh(); data.stop(); late.resolve(catalog("first")); await pending;
    expect(data.catalog).toBeUndefined();
    const failed = new ComposerCatalogState(fixture({ getComposerCatalog: async () => { throw new Error("Owning host unavailable"); } }), "other", { projectId: "new-project" });
    failed.setConnected(true); await failed.refresh(); expect(failed.error).toBe("Owning host unavailable");
    const saved = draft({ model: { provider: "missing", id: "retained" }, thinkingLevel: "max" });
    const html = renderToStaticMarkup(<ComposerSelections data={failed} draft={saved} disabled={false} onChange={() => {}}/>);
    expect(html).toContain("retained max"); expect(html).toContain('aria-label="Model and reasoning effort"');
    expect(saved.model?.id).toBe("retained"); failed.stop();
  });
  test("a follow-current draft omits model from delivery while explicit choices and later text survive", async () => {
    const requests: any[] = []; let revision = 0;
    const send = async (envelope: any) => {
      requests.push(envelope.command);
      return envelope.command.type === "draft.put"
        ? { ok: true as const, commandId: envelope.id, value: { ...envelope.command.draft, revision: ++revision, updatedAt: 1 } }
        : { ok: true as const, commandId: envelope.id, value: session("second") };
    };
    const drafts = new DraftController(send, "owner"); const submissions = new SubmissionController(send, "owner");
    drafts.setConnected(true); drafts.get("session:session", { projectId: "project" });
    drafts.update("session:session", { text: "Send using the current session" });
    const first = await drafts.prepareSubmission("session:session");
    expect(first.model).toBeNull(); await submissions.submit(first, "session", "prompt"); drafts.finishSubmission(first.id, first, true);
    expect(requests.find(item => item.type === "session.prompt").model).toBeUndefined();
    drafts.update(first.id, { text: "Use the chosen model", model: { provider: "contract", id: "first" }, thinkingLevel: "high" });
    const second = await drafts.prepareSubmission(first.id); drafts.update(first.id, { text: "Later edit" });
    await submissions.submit(second, "session", "prompt"); drafts.finishSubmission(second.id, second, true);
    expect(requests.filter(item => item.type === "session.prompt").at(-1)).toMatchObject({ model: { id: "first" }, thinkingLevel: "high", text: "Use the chosen model" });
    expect(drafts.get(first.id).draft.text).toBe("Later edit"); drafts.dispose();
  });
});
