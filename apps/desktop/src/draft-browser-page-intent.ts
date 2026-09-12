import { parseDraftBrowserWindowIntent, parseDraftBrowserWindowIntents, type DraftBrowserWindowIntent } from "./draft-browser-window-intent";
import { parseBrowserNewTabState, type BrowserNewTabState } from "./renderer/browser-new-tab";
import { parseNativeBrowserTabMetadata, type NativeBrowserTabMetadata } from "@agent-desktop/shared";

export interface DraftBrowserConfirmedTarget { workerPid: number; tab: NativeBrowserTabMetadata }

/** Original draft owner and local page identity. This is not a session/DockTab
 * descriptor. The window-persistence consumer must acknowledge the full request. */
export interface DraftBrowserPageIntent {
  version: 1;
  instanceId: string;
  owner: DraftBrowserWindowIntent;
  launcher: BrowserNewTabState;
  /** Historical result, not permission to use an unverified restored worker. */
  confirmedTarget?: DraftBrowserConfirmedTarget;
}
export function parseDraftBrowserPageIntent(value: unknown): DraftBrowserPageIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["version", "instanceId", "owner", "launcher", "confirmedTarget"].includes(key))) throw new Error("Invalid draft browser page intent.");
  const intent = value as DraftBrowserPageIntent;
  if (intent.version !== 1 || typeof intent.instanceId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(intent.instanceId)) throw new Error("Invalid draft browser page identity.");
  const launcher = parseBrowserNewTabState(intent.launcher);
  let confirmedTarget: DraftBrowserConfirmedTarget | undefined;
  if (intent.confirmedTarget !== undefined) {
    const target = intent.confirmedTarget;
    if (!target || typeof target !== "object" || Array.isArray(target)
      || Object.keys(target).some(key => key !== "workerPid" && key !== "tab")
      || !Number.isSafeInteger(target.workerPid) || target.workerPid <= 0
      || launcher.status !== "unknown" || !launcher.request) throw new Error("Invalid confirmed draft browser target.");
    const tab = parseNativeBrowserTabMetadata(target.tab);
    if (tab.state !== "alive" || tab.name !== `desktop-${launcher.request.requestId}`) throw new Error("The saved draft browser target does not match its request.");
    confirmedTarget = { workerPid: target.workerPid, tab };
  }
  return { version: 1, instanceId: intent.instanceId, owner: parseDraftBrowserWindowIntent(intent.owner), launcher,
    ...(confirmedTarget ? { confirmedTarget } : {}) };
}
export function createDraftBrowserPageIntent(owner: DraftBrowserWindowIntent, instanceId: string = crypto.randomUUID()): DraftBrowserPageIntent {
  return parseDraftBrowserPageIntent({ version: 1, instanceId, owner, launcher: { status: "idle" } });
}

/** Local recovery is bounded by the existing window tab capacity. Never prune
 * requests to fit; the document's byte limit is enforced by WindowStateStore. */
export function parseDraftBrowserPageIntents(value: unknown, ownerValues: unknown): DraftBrowserPageIntent[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Too many draft browser pages in this window.");
  const owners = parseDraftBrowserWindowIntents(ownerValues);
  const pages = new Set<string>(), requests = new Set<string>();
  return value.map(raw => {
    const page = parseDraftBrowserPageIntent(raw), owner = page.owner;
    if (!owners.some(candidate => JSON.stringify(candidate) === JSON.stringify(owner))) throw new Error("A draft page requires its original retained browser owner.");
    const identity = JSON.stringify([owner.hostId, page.instanceId]);
    if (pages.has(identity)) throw new Error("Duplicate draft browser page identity."); pages.add(identity);
    if (page.launcher.request) {
      const request = JSON.stringify([owner.hostId, owner.reference.ownerId, page.launcher.request.requestId]);
      if (requests.has(request)) throw new Error("A draft browser request cannot belong to two local pages."); requests.add(request);
    }
    return page;
  });
}
