import type { DraftBrowserBridge, DraftBrowserMetadataSnapshot } from "@agent-desktop/shared";
import { readBrowserMetadataLimited } from "./browser-metadata-admission";
import { parseDraftBrowserPageIntent, type DraftBrowserPageIntent } from "../draft-browser-page-intent";
import type { CommandBrowserTab } from "./command-browser-tabs";
import { dockTabId, draftBrowserIdFromDock } from "./dock-state";
import type { DockPresentations } from "./dock-presentations";

/** Confirmed page history can be searched without granting native readiness.
 * The current App's draft route is new-conversation; do not map another saved
 * draft into it or fabricate a session route during first-Send handoff. */
export function draftBrowserSearchSources(presentations: DockPresentations, values: readonly DraftBrowserPageIntent[]): Array<{ page: DraftBrowserPageIntent; entry: CommandBrowserTab }> {
  const attached = new Set([...presentations.snapshot.state.right.tabIds, ...presentations.snapshot.state.bottom.tabIds]);
  return presentations.snapshot.tabs.flatMap(tab => {
    const instance = presentations.instances.get(tab.id), draftId = draftBrowserIdFromDock(tab.target);
    if (tab.kind !== "browser" || draftId !== "new-conversation" || !tab.browserInstanceId || tab.browserTarget
      || !tab.browserNewTab || tab.id !== dockTabId(tab) || !instance || !attached.has(tab.id)) return [];
    const candidates = values.filter(page => page.instanceId === tab.browserInstanceId && page.owner.hostId === tab.hostId
      && page.owner.reference.draftId === draftId);
    if (candidates.length !== 1) return [];
    let page: DraftBrowserPageIntent;
    try { page = parseDraftBrowserPageIntent(candidates[0]); } catch { return []; }
    const observed = page.confirmedTarget;
    if (!observed?.tab.url) return [];
    const sourceKey = JSON.stringify([instance, tab.id, page.owner, page.instanceId, page.launcher.request,
      observed.workerPid, observed.tab.name, observed.tab.targetId, observed.tab.backend, observed.tab.kindTag]);
    return [{ page, entry: { id: tab.id, hostId: tab.hostId, sessionId: null, draftId, title: tab.title === "New tab" ? observed.tab.title ?? "" : tab.title,
      pageTitle: observed.tab.title ?? "", url: observed.tab.url, detailsUnavailable: true, sourceKey } }];
  });
}

export function draftBrowserSearchEntries(presentations: DockPresentations, values: readonly DraftBrowserPageIntent[]): CommandBrowserTab[] {
  return draftBrowserSearchSources(presentations, values).map(source => source.entry);
}

export const draftBrowserSearchOwner = (page: DraftBrowserPageIntent) => JSON.stringify([page.owner.hostId, page.owner.reference]);

/** Lookup only original confirmed owners; no status, acquire or create fallback.
 * Session and draft search share the same uncancellable-read admission limit. */
export async function readDraftBrowserSearchMetadata(pages: readonly DraftBrowserPageIntent[], connected: ReadonlySet<string>,
  bridge: Pick<DraftBrowserBridge, "metadata"> | undefined, signal: AbortSignal): Promise<Map<string, DraftBrowserMetadataSnapshot>> {
  const owners = new Map(pages.filter(page => connected.has(page.owner.hostId)).map(page => [draftBrowserSearchOwner(page), structuredClone(page.owner)]));
  const result = new Map<string, DraftBrowserMetadataSnapshot>(), pending = [...owners];
  if (!pending.length || !bridge) return result;
  const read = bridge.metadata.bind(bridge);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (!signal.aborted) {
      const item = pending[next++]; if (!item) return;
      const [key, owner] = item;
      try {
        const value = await readBrowserMetadataLimited(() => read({ ...owner.reference }, owner.hostId), signal);
        if (!signal.aborted && value?.protocolVersion === 1 && value.ownerKind === "draft" && value.hostId === owner.hostId
          && value.ownerId === owner.reference.ownerId) result.set(key, value);
      } catch { /* Preserve last observed text; an error is not evidence of native closure. */ }
    }
  }));
  return result;
}
