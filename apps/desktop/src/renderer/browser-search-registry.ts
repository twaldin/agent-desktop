import { parseSessionBrowserObservations, matchesSessionBrowserObservation, type SessionBrowserObservation } from "../session-browser-observation";
import type { DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { draftBrowserSearchEntries, draftBrowserSearchSources, draftBrowserSearchOwner } from "./draft-browser-search";
import { parseBrowserTargetObservation, parseNativeBrowserTabMetadata, type BrowserMetadataSnapshot, type DraftBrowserMetadataSnapshot, type BrowserTargetObservation } from "@agent-desktop/shared";
import type { BrowserSearchObservationTarget } from "./browser-search-observation";
import type { DockTab } from "./dock-state";
import type { DockPresentations } from "./dock-presentations";
import { browserSearchEntries, browserSearchOwner, browserSearchPresentationKey, windowBrowserTabs, type CommandBrowserTab } from "./command-browser-tabs";

type ObservedPage = { sourceKey: string; revision: number; observationRevision: number; tab: DockTab; absent?: boolean; entry?: CommandBrowserTab; draft?: { page: DraftBrowserPageIntent; seed: CommandBrowserTab } };

/** Last observed search text for original window presentations. It is neither
 * native readiness nor permission to restore, acquire or control a browser. */
export class BrowserSearchRegistry {
  private readonly pages = new Map<string, ObservedPage>();
  private generation = 0;
  private restored: SessionBrowserObservation[];
  constructor(restored: readonly SessionBrowserObservation[] = []) { this.restored = parseSessionBrowserObservations(restored); }

  /** Project against this render's exact dock without adopting render-only state.
   * Before first commit, preserve the bootstrap history in the initial save. */
  persisted(presentations: DockPresentations): SessionBrowserObservation[] {
    const tabs = windowBrowserTabs(presentations.snapshot);
    const live = [...this.pages.values()].flatMap(page => {
      if (page.draft || !page.entry || browserSearchPresentationKey(presentations, page.tab.id) !== page.sourceKey) return [];
      const tab = tabs.find(tab => tab.id === page.tab.id)!;
      return [{ version: 1 as const, tabId: tab.id, hostId: tab.hostId, sessionId: tab.target.slice(8),
        target: { ...tab.browserTarget! }, pageTitle: page.entry.pageTitle, url: page.entry.url }];
    });
    return [...live, ...this.restored.filter(value => tabs.some(tab => matchesSessionBrowserObservation(value, tab)))].map(value => ({ ...value, target: { ...value.target } }));
  }

  /** Only committed presentation transitions mutate ownership. Render-only
   * projections below cannot adopt a replacement or retire an existing record. */
  commit(presentations: DockPresentations, draftPages: readonly DraftBrowserPageIntent[] = []) {
    const drafts = new Map(draftBrowserSearchSources(presentations, draftPages).map(source => [source.entry.id, source]));
    const sessions = new Set(windowBrowserTabs(presentations.snapshot).map(tab => tab.id));
    const tabs = presentations.snapshot.tabs.filter(tab => sessions.has(tab.id) || drafts.has(tab.id)), keys = new Map(tabs.flatMap(tab => {
      const key = drafts.get(tab.id)?.entry.sourceKey ?? browserSearchPresentationKey(presentations, tab.id);
      return key === undefined ? [] : [[tab.id, key] as const];
    }));
    for (const [id, page] of this.pages) if (keys.get(id) !== page.sourceKey) this.pages.delete(id);
    for (const tab of tabs) {
      const sourceKey = keys.get(tab.id); if (sourceKey === undefined) continue;
      const page = this.pages.get(tab.id);
      const source = drafts.get(tab.id);
      if (page) {
        page.tab = structuredClone(tab);
        if (source) {
          // Repeated committed renders must not replace a live observation (or
          // confirmed absence) with the same older saved history.
          if (!page.absent && (!page.draft || page.draft.seed.url !== source.entry.url || page.draft.seed.pageTitle !== source.entry.pageTitle)) page.entry = source.entry;
          page.draft = { page: source.page, seed: source.entry };
        }
      } else {
        const saved = !source && this.restored.find(value => matchesSessionBrowserObservation(value, tab));
        this.pages.set(tab.id, { sourceKey, revision: 0, observationRevision: 0, tab: structuredClone(tab),
          ...(source ? { entry: source.entry, draft: { page: source.page, seed: source.entry } } : saved ? {
            entry: { id: tab.id, hostId: tab.hostId, sessionId: saved.sessionId, title: tab.title,
              pageTitle: saved.pageTitle, url: saved.url, sourceKey, detailsUnavailable: true },
          } : {}) });
      }
    }
    // Bootstrap is consumed once, including absent/mismatched presentations.
    // Reopening later cannot revive retired observations from startup history.
    this.restored = [];
  }

  invalidateReads() {
    this.generation++;
    this.stale();
  }

  private stale() {
    for (const page of this.pages.values()) if (page.entry) page.entry = { ...page.entry, detailsUnavailable: true };
  }

  /** Capture record objects, not just their serializable keys: an A->B->A target
   * transition must not let an old read publish into the new A incarnation. */
  read() { return this.capture([...this.pages.values()], true); }

  /** Called before an existing preview read starts. The original committed record
   * and read order are retained even if callbacks or reusable IDs later change. */
  observe(id: string, sourceKey: string | undefined) {
    const page = this.pages.get(id);
    if (!page || page.sourceKey !== sourceKey) return undefined;
    const read = this.capture([page]);
    return (value: BrowserMetadataSnapshot | DraftBrowserMetadataSnapshot | null) => {
      if (page.draft) read.publish(new Map(), value && "ownerKind" in value
        ? new Map([[draftBrowserSearchOwner(page.draft.page), value]]) : new Map());
      else read.publish(value && "sessionId" in value ? new Map([[browserSearchOwner(page.tab.hostId, page.tab.target.slice(8)), value]]) : new Map());
    };
  }

  private capture(pages: ObservedPage[], inspect = false) {
    const generation = this.generation;
    const revisions = new Map(pages.map(page => [page, ++page.revision]));
    const observationRevisions = new Map(pages.filter(page => inspect).map(page => [page, ++page.observationRevision]));
    const targets = new Map<ObservedPage, BrowserSearchObservationTarget>(pages.filter(page => inspect && !page.absent).map(page => {
      const intent = page.draft?.page, confirmed = intent?.confirmedTarget;
      return [page, { key: page.sourceKey, hostId: page.tab.hostId,
        owner: intent ? { kind: "draft", ...intent.owner.reference } : { kind: "session", sessionId: page.tab.target.slice(8) },
        target: confirmed ? { workerPid: confirmed.workerPid, name: confirmed.tab.name, targetId: confirmed.tab.targetId } : { ...page.tab.browserTarget! } }];
    }));
    return {
      tabs: pages.filter(page => !page.draft && !page.absent).map(page => structuredClone(page.tab)),
      drafts: pages.flatMap(page => page.draft && !page.absent ? [structuredClone(page.draft.page)] : []),
      targets: [...targets.values()].map(value => structuredClone(value)),
      publish: (metadata: ReadonlyMap<string, BrowserMetadataSnapshot>, draftMetadata: ReadonlyMap<string, DraftBrowserMetadataSnapshot> = new Map(), observations: ReadonlyMap<string, BrowserTargetObservation> = new Map()) => {
        if (generation !== this.generation) return;
        for (const page of pages) {
          if (this.pages.get(page.tab.id) !== page || page.absent) continue;
          const selected = targets.get(page);
          if (selected && page.observationRevision === observationRevisions.get(page)) {
            try {
              const observed = parseBrowserTargetObservation(observations.get(selected.key), selected.hostId, selected.owner, selected.target);
              if ((!page.draft || observed.kindTag === page.draft.page.confirmedTarget!.tab.kindTag) && observed.presence === "absent") {
                page.absent = true; page.entry = undefined; continue;
              }
            } catch { /* Missing, malformed or foreign observations never establish absence. */ }
          }
          // Preview metadata may update text during a held inspection, but it
          // cannot supersede that inspection's separate original-target authority.
          if (page.revision !== revisions.get(page)) continue;
          if (page.draft) { this.publishDraft(page, draftMetadata.get(draftBrowserSearchOwner(page.draft.page))); continue; }
          const key = browserSearchOwner(page.tab.hostId, page.tab.target.slice(8)), value = metadata.get(key);
          // Unavailable, failed or malformed reads preserve only historical text.
          // Cached native maps, worker replacement and detach/dead states do not
          // establish absence. Only the original target observation above can.
          if (value?.protocolVersion === 1 && value.hostId === page.tab.hostId && value.sessionId === page.tab.target.slice(8)
            && value.availability === "running" && Number.isSafeInteger(value.workerPid) && value.workerPid > 0 && Array.isArray(value.tabs)) {
            try {
              const normalized = { ...value, tabs: value.tabs.map(parseNativeBrowserTabMetadata) };
              const entry = browserSearchEntries([page.tab], new Map([[key, normalized]]))[0];
              if (entry) { page.entry = { ...entry, sourceKey: page.sourceKey }; continue; }
            } catch { /* Invalid native details do not prove closure. */ }
          }
          if (page.entry) page.entry = { ...page.entry, detailsUnavailable: true };
        }
      },
    };
  }

  private publishDraft(page: ObservedPage, value: DraftBrowserMetadataSnapshot | undefined) {
    const { page: intent, seed } = page.draft!, owner = intent.owner, target = intent.confirmedTarget!;
    if (value?.protocolVersion === 1 && value.ownerKind === "draft" && value.hostId === owner.hostId && value.ownerId === owner.reference.ownerId
      && value.availability === "running" && Number.isSafeInteger(value.workerPid) && value.workerPid > 0 && Array.isArray(value.tabs)) {
      try {
        const tabs = value.tabs.map(parseNativeBrowserTabMetadata);
        const candidate = tabs.find(tab => tab.name === target.tab.name && tab.targetId === target.tab.targetId);
        if (value.workerPid === target.workerPid && candidate?.state === "alive"
          && candidate.backend === target.tab.backend && candidate.kindTag === target.tab.kindTag) {
          page.entry = { ...seed, pageTitle: candidate.title ?? "", url: candidate.url, detailsUnavailable: false };
          return;
        }
      } catch { /* Malformed metadata does not establish absence. */ }
    }
    if (page.entry) page.entry = { ...page.entry, detailsUnavailable: true };
  }

  entries(presentations: DockPresentations, connected: ReadonlySet<string>, draftPages: readonly DraftBrowserPageIntent[] = []): CommandBrowserTab[] {
    const drafts = new Map(draftBrowserSearchEntries(presentations, draftPages).map(entry => [entry.id, entry]));
    return [...this.pages.values()].flatMap(page => {
      if (!page.entry || (drafts.get(page.tab.id)?.sourceKey ?? browserSearchPresentationKey(presentations, page.tab.id)) !== page.sourceKey) return [];
      const tab = presentations.snapshot.tabs.find(tab => tab.id === page.tab.id)!;
      return [{ ...page.entry, title: page.draft && tab.title === "New tab" ? page.entry.pageTitle : tab.title, detailsUnavailable: page.entry.detailsUnavailable || !connected.has(tab.hostId) }];
    });
  }
}
