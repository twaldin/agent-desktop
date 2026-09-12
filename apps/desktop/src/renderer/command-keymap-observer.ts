import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { CommandKeymapState } from "./command-keymap-state";

/** Coalesce bursts, but reread when a preference event arrives during a snapshot. */
export function observeCommandKeymap(state: CommandKeymapState, bridge: Pick<DesktopBridge, "subscribe">) {
  let stopped = false;
  let dirty = false;
  let draining: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (draining) return draining;
    const run = async () => {
      while (!stopped && dirty) {
        dirty = false;
        await state.restore();
        if (!stopped && state.available) await state.refresh();
      }
    };
    draining = run().finally(() => {
      draining = undefined;
      if (!stopped && dirty) void refresh();
    });
    return draining;
  };
  const unsubscribe = bridge.subscribe(event => {
    if (event.type === "preferences" && (event.hostId ?? state.hostId) === state.hostId) void refresh();
  });
  return { refresh, stop() { stopped = true; dirty = false; unsubscribe(); } };
}
