import { useLayoutEffect, useRef } from "react";

export function McpForgetAuthorizationDialog({ serverName, onCancel, onConfirm }: {
  serverName: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      const active = document.activeElement;
      const ownedFocus = active === document.body || Boolean(active && element?.contains(active));
      element?.close();
      const current = document.activeElement;
      const original = returnFocus.current;
      if (ownedFocus && original?.isConnected && !original.matches(":disabled, [hidden]")
        && original.getClientRects().length > 0
        && (current === document.body || current === original || Boolean(current && element?.contains(current)))) {
        original.focus({ preventScroll: true });
      }
    };
  }, []);
  return <dialog ref={dialog} className="app-dialog" aria-labelledby="mcp-forget-title" onCancel={onCancel}>
    <div className="dialog-header"><h2 id="mcp-forget-title">Forget OAuth authorization?</h2></div>
    <p>Clear the owning host’s stored OAuth authorization for <strong>{serverName}</strong> and reload this session’s MCP servers.</p>
    <p>Other servers sharing the same stored URL credential may need to sign in again. Explicit headers, environment credentials and credentials managed by a separate server process stay unchanged. This does not revoke a token at the provider.</p>
    <div className="dialog-footer">
      <button className="secondary-button" type="button" autoFocus onClick={onCancel}>Cancel</button>
      <button className="primary-button" type="button" onClick={onConfirm}>Forget authorization</button>
    </div>
  </dialog>;
}
