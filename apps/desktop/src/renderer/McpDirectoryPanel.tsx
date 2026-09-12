import { useEffect, useReducer, useRef } from "react";
import { InteractionCard } from "./PendingInteractions";
import type { McpDirectoryOwner } from "./mcp-directory-owner";
export function McpDirectoryStatus({ owner, cwd, hostLabel }: { owner: McpDirectoryOwner; cwd: string; hostLabel: string }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => owner.subscribe(redraw), [owner]);
  return <section aria-label="App connection" className="mcp-directory-status">
    <p>{hostLabel} · {cwd}</p>
    {owner.error && <p role="alert">{owner.error}</p>}
    {owner.snapshot?.interactions.map(request => <InteractionCard key={request.id} request={request} disabled={!owner.current() || owner.responding.has(request.id)} sending={owner.responding.has(request.id)} respond={response => owner.respond(request.id, response)}/>)}
    {owner.current() && <button type="button" className="secondary-button" onClick={() => void owner.disconnect().catch(() => {})}>Disconnect apps</button>}
  </section>;
}

/** Pending native startup may itself request permission, before there is an app
 * iframe to display it in. Closing this view hides it; Disconnect retires it. */
export function McpDirectoryConnection({ owner, hostLabel, closeWhenReady, onClose }: { owner: McpDirectoryOwner; hostLabel: string; closeWhenReady: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef(onClose); close.current = onClose;
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => owner.subscribe(redraw), [owner]);
  useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
  useEffect(() => {
    if (closeWhenReady && owner.current() && owner.snapshot?.catalogue.available && owner.snapshot.catalogue.servers.some(server => server.status === "connected" && (server.apps?.length || server.fileViewers?.length)) && !owner.snapshot.interactions.length) close.current();
  }, [owner, owner.snapshot, closeWhenReady]);
  return <dialog ref={dialog} className="app-dialog" aria-label="App connections" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header"><h2>App connections</h2><button type="button" className="icon-button" aria-label="Close app connections" onClick={onClose}>×</button></div>
    <McpDirectoryStatus owner={owner} hostLabel={hostLabel} cwd={owner.snapshot?.cwd ?? "Host-admitted directory pending"}/>
    {!owner.error && !owner.snapshot?.catalogue.available && <p role="status">{owner.snapshot?.catalogue.reason ?? "Connecting to native app configuration…"}</p>}
    {owner.snapshot?.catalogue.available && !owner.snapshot.catalogue.servers.some(server => server.status === "connected" && (server.apps?.length || server.fileViewers?.length)) && <p>No apps are available in this directory. Check the native MCP server configuration on this host.</p>}
    {owner.snapshot?.catalogue.servers.flatMap(server => (server.fileViewers ?? []).map(viewer => <p key={`${server.name}:${viewer.toolName}`}>{viewer.title} · {viewer.extensions.join(", ")}</p>))}
    {owner.snapshot?.catalogue.servers.filter(server => server.status !== "connected").map(server => <p role="status" key={server.name}>{server.name}: {server.status}</p>)}
    {!owner.current() && !owner.loading && <button className="secondary-button" type="button" onClick={() => void owner.acquire().catch(() => {})}>Connect apps</button>}
  </dialog>;
}
