import { parseDraftBrowserOwnerReference, type DraftBrowserOwnerReference } from "@agent-desktop/shared";

/** Saved recovery identity, not proof of acquisition or permission to replay.
 * Native worker state and creation receipts remain on the owning host. */
export interface DraftBrowserWindowIntent {
  version: 1;
  hostId: string;
  reference: DraftBrowserOwnerReference;
}
export function parseDraftBrowserWindowIntent(value: unknown): DraftBrowserWindowIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["version", "hostId", "reference"].includes(key))) throw new Error("Invalid draft browser window intent.");
  const intent = value as DraftBrowserWindowIntent;
  if (intent.version !== 1 || typeof intent.hostId !== "string" || !intent.hostId || intent.hostId.length > 200
    || /[\u0000-\u001f\u007f]/.test(intent.hostId)) throw new Error("Invalid draft browser intent host or version.");
  const reference = parseDraftBrowserOwnerReference(intent.reference);
  if (Object.keys(intent.reference).some(key => !["ownerId", "draftId", "draftRevision"].includes(key))) throw new Error("Invalid draft browser binding fields.");
  return { version: 1, hostId: intent.hostId, reference };
}
/** Never evict existing owner knowledge to admit another request. */
export function parseDraftBrowserWindowIntents(value: unknown): DraftBrowserWindowIntent[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Too many saved draft browser owners in this window.");
  const seen = new Set<string>();
  return value.map(raw => {
    const intent = parseDraftBrowserWindowIntent(raw), key = JSON.stringify([intent.hostId, intent.reference.ownerId]);
    if (seen.has(key)) throw new Error("Duplicate draft browser window owner.");
    seen.add(key); return intent;
  });
}
