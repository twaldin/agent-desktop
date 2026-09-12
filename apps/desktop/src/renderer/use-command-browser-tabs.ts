import type { DraftBrowserPageIntent } from "../draft-browser-page-intent";
import { draftBrowserSearchEntries, readDraftBrowserSearchMetadata } from "./draft-browser-search";
import { useEffect, useLayoutEffect, useState } from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import type { DockPresentations } from "./dock-presentations";
import { browserSearchPresentationKey, readWindowBrowserMetadata, windowBrowserTabs } from "./command-browser-tabs";
import { BrowserSearchRegistry } from "./browser-search-registry";
import { readBrowserSearchObservations } from "./browser-search-observation";

export function useCommandBrowserTabs(open: boolean, presentations: DockPresentations, connectedHosts: readonly string[], bridge: DesktopBridge, draftPages: readonly DraftBrowserPageIntent[] = [], sharedRegistry?: BrowserSearchRegistry) {
  const [registry] = useState(() => sharedRegistry ?? new BrowserSearchRegistry());
  const [, redraw] = useState(0);
  // Preview text can change during an authoritative read of the same source.
  const identity = JSON.stringify([windowBrowserTabs(presentations.snapshot).map(tab => browserSearchPresentationKey(presentations, tab.id)),
    draftBrowserSearchEntries(presentations, draftPages).map(entry => entry.sourceKey)]);
  const connections = JSON.stringify([...connectedHosts].sort());
  useLayoutEffect(() => { registry.commit(presentations, draftPages); }, [registry, presentations, draftPages]);
  useLayoutEffect(() => { registry.invalidateReads(); redraw(value => value + 1); }, [open, identity, connections, bridge, registry]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const read = registry.read();
      const [metadata, draftMetadata, observations] = await Promise.all([
        readWindowBrowserMetadata(read.tabs, new Set(connectedHosts), bridge, controller.signal),
        readDraftBrowserSearchMetadata(read.drafts, new Set(connectedHosts), bridge.draftBrowser, controller.signal),
        readBrowserSearchObservations(read.targets, new Set(connectedHosts), bridge.browserObservation, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      read.publish(metadata, draftMetadata, observations); redraw(value => value + 1);
      timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    // Sent IPC is uncancellable. Keep observed text, retire this delivery, and
    // mark it historical until the original target is observed again.
    return () => { controller.abort(); clearTimeout(timer); registry.invalidateReads(); };
  }, [open, identity, connections, bridge, registry]);
  return registry.entries(presentations, new Set(connectedHosts), draftPages);
}
