import type { DesktopBridge, NotificationNavigationRequest } from "@agent-desktop/shared";

interface NotificationIpc {
  on(channel: string, listener: (event: unknown, message: NotificationNavigationRequest) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, message: NotificationNavigationRequest) => void): unknown;
  invoke(channel: string): Promise<unknown>;
  send(channel: string, value?: unknown): void;
}

export function createNotificationNavigationBridge(ipc: NotificationIpc): Pick<DesktopBridge, "subscribeNotificationNavigation" | "acknowledgeNotificationNavigation"> {
  return {
    subscribeNotificationNavigation: listener => {
      let active = true;
      const callback = (_event: unknown, message: NotificationNavigationRequest) => { if (active) listener(message); };
      ipc.on("desktop:notification-navigate", callback);
      void ipc.invoke("desktop:notification-ready").catch(() => {});
      return () => {
        active = false;
        ipc.removeListener("desktop:notification-navigate", callback);
        ipc.send("desktop:notification-unready");
      };
    },
    acknowledgeNotificationNavigation: id => ipc.send("desktop:notification-ack", id),
  };
}
