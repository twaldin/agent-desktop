import { browserAddressFocusOwner } from "./browser-address-focus";
import type { DesktopBridge } from "@agent-desktop/shared";
import type { DraftBrowserDockController } from "./draft-browser-dock-controller";
import type { PreviewMetadata } from "./browser-preview-source";
import { BrowserPanel } from "./BrowserPanel";
import { BrowserNewTabPanel } from "./BrowserNewTabPanel";

export function DraftBrowserDockPanel({ bridge, controller, active, onMetadata, onReadMetadata, onShortcutKeyDown }: {
  bridge: DesktopBridge; controller: DraftBrowserDockController; active: boolean;
  onReadMetadata?(): ((value: PreviewMetadata | null) => void) | undefined;
  onMetadata(title: string): void; onShortcutKeyDown?(event: KeyboardEvent): void;
}) {
  const ready = controller.ready;
  if (ready) return <BrowserPanel bridge={bridge} active={active && controller.connected}
    draftOwner={{ kind: "draft", hostId: ready.intent.owner.hostId, reference: ready.intent.owner.reference,
      target: { workerPid: ready.workerPid, name: ready.tab.name, targetId: ready.tab.targetId }, isCurrent: controller.previewGuard }}
    onReadMetadata={onReadMetadata} onMetadata={value => onMetadata(value.title || value.url || "Browser")} onShortcutKeyDown={onShortcutKeyDown}/>;
  return <BrowserNewTabPanel controller={controller} active={active && controller.enabled}
    addressOwner={browserAddressFocusOwner(controller.tab.hostId, "draft", controller.draftId)}
    recovery={<>
      {!controller.connected && <p className="browser-status" role="status">Reconnect to the original draft’s host to open this address.</p>}
      {controller.canChooseOwner && controller.ownerChoices.length > 1 && <div className="browser-status">
        {controller.ownerChoices.map((owner, index) => <button key={owner.reference.ownerId} type="button" disabled={!active || !controller.connected || controller.checking}
          onClick={() => { controller.chooseOwner(owner.reference.ownerId); void controller.inspect(); }}>Check saved browser {index + 1}</button>)}
      </div>}
      {controller.needsInspection && controller.state.status !== "unknown" && <div className="browser-status">
        <button type="button" disabled={!active || !controller.connected || controller.checking} onClick={() => { void controller.inspect(); }}>Check browser status</button>
      </div>}
    </>}/>;
}
