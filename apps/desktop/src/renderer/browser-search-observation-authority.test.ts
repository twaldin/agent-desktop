import { expect, test } from "bun:test";
import type { BrowserMetadataSnapshot, BrowserTargetObservation, DraftBrowserMetadataSnapshot } from "@agent-desktop/shared";
import { parseDraftBrowserPageIntent } from "../draft-browser-page-intent";
import { BrowserSearchRegistry } from "./browser-search-registry";
import { browserSearchOwner } from "./command-browser-tabs";
import { draftBrowserSearchOwner } from "./draft-browser-search";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDraftBrowserDockTab } from "./draft-browser-dock";
import { createDockState, insertDockTab } from "./dock-state";
import { reconcileDockPresentations } from "./dock-presentations";

function fixture(kind: "session" | "draft") {
  const page = parseDraftBrowserPageIntent({ version: 1, instanceId: "page", owner: { version: 1, hostId: "host",
    reference: { ownerId: "owner", draftId: "new-conversation", draftRevision: 1 } },
    launcher: { status: "unknown", request: { requestId: "page", controlEpoch: "epoch", observedAt: 1, initialUrl: "https://example.com/" } },
    confirmedTarget: { workerPid: 50, tab: { name: "desktop-page", targetId: "native", state: "alive", backend: "worker", kindTag: "headless",
      title: "Observed", url: "https://example.com/saved", viewport: { width: 800, height: 600 } } } });
  const target = { workerPid: 50, name: "desktop-page", targetId: "native" };
  const { browserNewTab: _unused, ...native } = createBrowserNewTab("host", "owner", "page");
  const tab = kind === "session" ? { ...native, browserTarget: target } : createDraftBrowserDockTab("host", "new-conversation", "page");
  const presentations = reconcileDockPresentations(undefined, { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") }, "original");
  const pages = kind === "draft" ? [page] : [], registry = new BrowserSearchRegistry(); registry.commit(presentations, pages);
  const metadata = () => ({ protocolVersion: 1 as const, hostId: "host", availability: "running" as const, workerPid: 50,
    tabs: [{ ...page.confirmedTarget!.tab }] });
  const session = () => new Map<string, BrowserMetadataSnapshot>(kind === "session" ? [[browserSearchOwner("host", "owner"), { ...metadata(), sessionId: "owner" }]] : []);
  const draft = () => new Map<string, DraftBrowserMetadataSnapshot>(kind === "draft" ? [[draftBrowserSearchOwner(page), { ...metadata(), ownerKind: "draft", ownerId: "owner" }]] : []);
  registry.read().publish(session(), draft());
  const entries = () => registry.entries(presentations, new Set(["host"]), pages);
  const key = entries()[0]!.sourceKey!;
  const observation = (): BrowserTargetObservation => ({ protocolVersion: 1, hostId: "host",
    owner: kind === "session" ? { kind: "session", sessionId: "owner" } : { kind: "draft", ...page.owner.reference },
    ...target, ownerId: "owner", kindTag: "headless", presence: "absent" });
  return { registry, presentations, pages, page, tab, key, entries, session, draft, observation };
}

for (const kind of ["session", "draft"] as const) {
  test(`${kind} cached metadata disappearance cannot erase observed history`, () => {
    const s = fixture(kind), before = structuredClone([s.presentations.snapshot, s.pages]);
    for (const change of ["missing", "dead", "worker"]) {
      const sessions = s.session(), drafts = s.draft();
      const value = [...sessions.values(), ...drafts.values()][0]!;
      if (value.availability !== "running") throw new Error("Expected running fixture");
      if (change === "missing") value.tabs = [];
      else if (change === "dead") value.tabs[0]!.state = "dead";
      else value.workerPid = 51;
      s.registry.read().publish(sessions, drafts);
      expect(s.entries()[0]).toMatchObject({ url: "https://example.com/saved", detailsUnavailable: true });
    }
    expect([s.presentations.snapshot, s.pages]).toEqual(before);
  });

  test(`${kind} exact absence wins over cached metadata and cannot be revived by preview or saved seed`, () => {
    const s = fixture(kind), before = structuredClone([s.presentations.snapshot, s.pages]);
    const stale = s.registry.observe(s.tab.id, s.key)!;
    const read = s.registry.read();
    s.registry.observe(s.tab.id, s.key)!([...s.session().values(), ...s.draft().values()][0]!);
    read.publish(s.session(), s.draft(), new Map([[s.key, s.observation()]]));
    expect(s.entries()).toEqual([]);
    const metadata = [...s.session().values(), ...s.draft().values()][0]!;
    stale(metadata); s.registry.observe(s.tab.id, s.key)!(metadata);
    s.registry.commit(s.presentations, s.pages);
    expect(s.entries()).toEqual([]);
    expect(s.registry.read().targets).toEqual([]);
    expect([s.presentations.snapshot, s.pages]).toEqual(before);
    if (kind === "draft") {
      const changed = structuredClone(s.page); changed.confirmedTarget!.tab.title = "Later saved title"; changed.confirmedTarget!.tab.url = "https://example.com/later";
      s.registry.commit(s.presentations, [changed]);
      expect(s.registry.entries(s.presentations, new Set(["host"]), [changed])).toEqual([]);
    }
  });

  test(`${kind} foreign observations and loss-return cannot retire the current record`, () => {
    const s = fixture(kind);
    for (const value of [{ ...s.observation(), hostId: "foreign" }, { ...s.observation(), ownerId: "foreign" },
      { ...s.observation(), targetId: "foreign" }, { ...s.observation(), workerPid: 51 }, { ...s.observation(), kindTag: "cmux" as const }]) {
      s.registry.read().publish(new Map(), new Map(), new Map([[s.key, value]])); expect(s.entries()).toHaveLength(1);
    }
    const old = s.registry.read(); s.registry.invalidateReads();
    s.registry.read().publish(s.session(), s.draft());
    old.publish(new Map(), new Map(), new Map([[s.key, s.observation()]]));
    expect(s.entries()[0]?.detailsUnavailable).toBe(false);
    const retired = s.registry.read();
    const empty = reconcileDockPresentations(s.presentations, { tabs: [], state: createDockState() }, "closed");
    const replacement = reconcileDockPresentations(empty, s.presentations.snapshot, "replacement");
    s.registry.commit(empty, []); s.registry.commit(replacement, s.pages);
    s.registry.read().publish(s.session(), s.draft());
    retired.publish(new Map(), new Map(), new Map([[s.key, s.observation()]]));
    expect(s.registry.entries(replacement, new Set(["host"]), s.pages)).toHaveLength(1);
  });
}
