import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountsSettings } from "../../../apps/desktop/src/renderer/AccountsSettings";
import type { DesktopBridge, DesktopEvent, SessionSummary } from "../../../packages/shared/src/protocol";
import "../../../apps/desktop/src/renderer/styles.css";

// Only disposable provider responses cross this fixture IPC boundary. The rendered
// page, state controller, input events and action handlers are production code.
const api = (window as unknown as { accountsFixture: {
  invoke(method: string, args: unknown[]): Promise<unknown>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
} }).accountsFixture;
const bridge = {
  getProviders: (host: string) => api.invoke("getProviders", [host]),
  getLogins: (host: string) => api.invoke("getLogins", [host]),
  getAccounts: (provider: string, host: string) => api.invoke("getAccounts", [provider, host]),
  getSessionAccounts: (session: string, host: string) => api.invoke("getSessionAccounts", [session, host]),
  accountAction: (action: unknown, host: string) => api.invoke("accountAction", [action, host]),
  openExternal: (url: string) => api.invoke("openExternal", [url]),
  subscribe: api.subscribe,
} as unknown as DesktopBridge;
function App() {
  const [connected, setConnected] = useState(true);
  const [host, setHost] = useState("fixture-host");
  const [open, setOpen] = useState(true);
  const [changes, setChanges] = useState(0);
  return <><nav aria-label="Fixture controls">
    <button id="connection" onClick={() => setConnected(value => !value)}>{connected ? "Disconnect fixture" : "Reconnect fixture"}</button>
    <button id="owner" onClick={() => setHost(value => value === "fixture-host" ? "other-host" : "fixture-host")}>Change fixture host</button>
    <button id="reopen" onClick={() => setOpen(true)}>Open Accounts</button>
    <output id="changes">{changes}</output>
  </nav>{open && <AccountsSettings bridge={bridge} hostId={host} hostName={host} localHostId={host} connected={connected}
    session={{ id: "session", title: "Fixture session", status: "idle", model: { provider: "fixture-native", id: "fixture-model" } } as SessionSummary}
    onClose={() => setOpen(false)} onChanged={() => setChanges(value => value + 1)}/>}</>;
}
createRoot(document.getElementById("root")!).render(<App/>);
