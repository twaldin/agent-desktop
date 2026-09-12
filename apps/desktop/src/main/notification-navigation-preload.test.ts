import { expect, test } from "bun:test";
import type { NotificationNavigationRequest } from "@agent-desktop/shared";
import { createNotificationNavigationBridge } from "./notification-navigation-preload";

test("preload announces document readiness but only an explicit saved-route acknowledgement clears a click", async () => {
  let callback: ((event: unknown, message: NotificationNavigationRequest) => void) | undefined;
  const sent: unknown[][] = [], invoked: string[] = [], received: NotificationNavigationRequest[] = [];
  const ipc = {
    on(channel: string, listener: typeof callback) { expect(channel).toBe("desktop:notification-navigate"); callback = listener; },
    removeListener(channel: string, listener: typeof callback) { expect(channel).toBe("desktop:notification-navigate"); if (callback === listener) callback = undefined; },
    async invoke(channel: string) { invoked.push(channel); },
    send(channel: string, value?: unknown) { sent.push(value === undefined ? [channel] : [channel, value]); },
  };
  const bridge = createNotificationNavigationBridge(ipc);
  const stop = bridge.subscribeNotificationNavigation!(request => received.push(request));
  await Promise.resolve();
  expect(invoked).toEqual(["desktop:notification-ready"]);
  const request: NotificationNavigationRequest = { id: "click", target: { hostId: "host", sessionId: "session" } };
  callback?.({}, request);
  expect(received).toEqual([request]);
  expect(sent).toEqual([]);
  bridge.acknowledgeNotificationNavigation!(request.id);
  expect(sent).toEqual([["desktop:notification-ack", "click"]]);
  stop();
  expect(sent.at(-1)).toEqual(["desktop:notification-unready"]);
  callback?.({}, request);
  expect(received).toHaveLength(1);
});
