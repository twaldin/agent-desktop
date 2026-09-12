import { browserAddressFocusOwner } from "./browser-address-focus";
import {
  parseBrowserControlRequest, parseDraftBrowserOwnerReference, validBrowserFrameTarget,
  type BrowserControlReceipt, type BrowserControlRequest, type BrowserFrameSnapshot, type BrowserFrameTarget,
  type BrowserMetadataSnapshot, type DesktopBridge, type DraftBrowserControlReceipt, type DraftBrowserFrameSnapshot,
  type DraftBrowserMetadataSnapshot, type DraftBrowserOwnerReference,
} from "@agent-desktop/shared";

export type BrowserPreviewOwner = { kind: "session"; hostId: string; sessionId: string } | {
  kind: "draft"; hostId: string; reference: DraftBrowserOwnerReference; target: BrowserFrameTarget;
  /** Capture the original window-page readiness generation, never a live boolean alone. */
  isCurrent(): boolean;
};
export type PreviewMetadata = BrowserMetadataSnapshot | DraftBrowserMetadataSnapshot;
export type PreviewFrame = BrowserFrameSnapshot | DraftBrowserFrameSnapshot;
export type PreviewReceipt = BrowserControlReceipt | DraftBrowserControlReceipt;
const same = (a: BrowserFrameTarget, b: BrowserFrameTarget) => a.workerPid === b.workerPid && a.name === b.name && a.targetId === b.targetId;

/** Route the existing preview through its real owner. No acquisition, inspection,
 * retry, session stand-in or replacement-target selection happens here. */
export function browserPreviewSource(bridge: DesktopBridge, input: BrowserPreviewOwner) {
  const owner: BrowserPreviewOwner = input.kind === "session" ? { ...input } : {
    ...input, reference: parseDraftBrowserOwnerReference(input.reference), target: { ...input.target },
  };
  if (owner.kind === "draft" && !validBrowserFrameTarget(owner.target)) throw new Error("Invalid original draft browser target.");
  const draftBridge = bridge.draftBrowser;
  let retired = false;
  const current = () => {
    if (owner.kind === "draft" && !owner.isCurrent()) retired = true;
    return !retired;
  };
  const assertCurrent = () => { if (!current()) throw new Error("Return to and inspect the original draft browser page."); };
  const identity = (value: PreviewMetadata | PreviewFrame | PreviewReceipt) => value.protocolVersion === 1 && value.hostId === owner.hostId
    && (owner.kind === "session" ? "sessionId" in value && !("ownerKind" in value) && value.sessionId === owner.sessionId
      : "ownerKind" in value && value.ownerKind === "draft" && !("sessionId" in value) && value.ownerId === owner.reference.ownerId);
  const target = (value: BrowserFrameTarget) => {
    if (!validBrowserFrameTarget(value) || owner.kind === "draft" && !same(value, owner.target)) throw new Error("The browser target changed.");
    return { workerPid: value.workerPid, name: value.name, targetId: value.targetId };
  };
  const addressOwner = owner.kind === "session" ? [owner.hostId, owner.sessionId]
    : ["draft", owner.hostId, owner.reference.ownerId, owner.reference.draftId, owner.reference.draftRevision];
  return {
    kind: owner.kind,
    key: JSON.stringify(owner.kind === "session" ? ["session", ...addressOwner] : [...addressOwner, owner.target]),
    addressOwner: JSON.stringify(addressOwner),
    focusOwner: browserAddressFocusOwner(owner.hostId, owner.kind, owner.kind === "session" ? owner.sessionId : owner.reference.draftId),
    selectionKey: owner.kind === "session" ? `browser.preview.selected.${owner.hostId}.${owner.sessionId}` : `browser.preview.selected.${JSON.stringify(addressOwner)}`,
    canRead: owner.kind === "session" ? Boolean(bridge.getBrowserMetadata && bridge.getBrowserFrame) : Boolean(draftBridge),
    canControl: owner.kind === "session" ? Boolean(bridge.controlBrowser) : Boolean(draftBridge),
    current,
    async metadata(): Promise<PreviewMetadata | null> {
      assertCurrent();
      const value = owner.kind === "session" ? await bridge.getBrowserMetadata?.(owner.sessionId, owner.hostId) ?? null
        : await draftBridge?.metadata({ ...owner.reference }, owner.hostId) ?? null;
      assertCurrent();
      if (value && (!identity(value) || owner.kind === "draft" && value.availability === "running" && value.workerPid !== owner.target.workerPid))
        throw new Error("Browser tab metadata belongs to a different owner.");
      return value;
    },
    async frame(selected: BrowserFrameTarget): Promise<PreviewFrame> {
      assertCurrent(); const original = target(selected);
      const value = owner.kind === "session" ? await bridge.getBrowserFrame?.(owner.sessionId, original, owner.hostId)
        : await draftBridge?.frame({ ...owner.reference }, original, owner.hostId);
      assertCurrent();
      if (!value || !identity(value) || !same(value, original) || value.mimeType !== "image/jpeg") throw new Error("The browser viewport belongs to a different owner or tab.");
      return value;
    },
    async control(input: BrowserControlRequest): Promise<PreviewReceipt> {
      assertCurrent(); const request = parseBrowserControlRequest(input); target(request.target);
      const value = owner.kind === "session" ? await bridge.controlBrowser?.(owner.sessionId, request, owner.hostId)
        : await draftBridge?.control({ ...owner.reference }, request, owner.hostId);
      assertCurrent();
      if (!value || !identity(value) || value.requestId !== request.requestId || !same(value, request.target)) throw new Error("The browser action receipt belongs to a different owner or tab.");
      return value;
    },
  };
}
export type BrowserPreviewSource = ReturnType<typeof browserPreviewSource>;
