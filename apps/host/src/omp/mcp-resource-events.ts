import { retainResourceSubscription } from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
interface Hub { previous: MCPServerConnection["transport"]["onNotification"]; receive(method: string, params: unknown): void; listeners: Set<(method: string, params: unknown) => void> }
const hubs = new WeakMap<MCPServerConnection, Hub>();
/** Observe the exact transport, including events received while subscribe awaits.
 * A replacement connection never inherits these callbacks or subscription claims. */
export async function subscribeMcpResource(connection: MCPServerConnection, uri: string, changed: () => void, signal: AbortSignal): Promise<{ release(): Promise<void> }> {
  let hub = hubs.get(connection);
  if (!hub) {
    const listeners = new Set<(method: string, params: unknown) => void>(), previous = connection.transport.onNotification;
    hub = { previous, listeners, receive(method, params) {
      try { previous?.(method, params); }
      finally { for (const listener of [...listeners]) listener(method, params); }
    } };
    hubs.set(connection, hub); connection.transport.onNotification = hub.receive;
  }
  const original = hub;
  const listener = (method: string, params: unknown) => {
    if (method === "notifications/resources/updated" && params && typeof params === "object" && "uri" in params && params.uri === uri && !signal.aborted) changed();
  };
  original.listeners.add(listener);
  const remove = () => {
    original.listeners.delete(listener);
    if (!original.listeners.size && hubs.get(connection) === original) {
      hubs.delete(connection);
      if (connection.transport.onNotification === original.receive) connection.transport.onNotification = original.previous;
    }
  };
  try {
    const lease = await retainResourceSubscription(connection, uri, { signal });
    let release: Promise<void> | undefined;
    return { release: () => { remove(); return release ??= lease.release(); } };
  } catch (error) { remove(); throw error; }
}
