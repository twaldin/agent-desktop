import { expect, test } from "bun:test";
import React from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import { useWindowClose } from "./WindowClose";

type Slot = { deps: readonly unknown[]; value?: unknown; cleanup?: () => void };
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

function driver(root: { current: HTMLElement | null }) {
  const slots: Slot[] = [];
  let cursor = 0, pending: Array<{ index: number; deps: readonly unknown[]; effect: () => void | (() => void) }> = [];
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useRef<T>(value: T) { const index = cursor++; return (slots[index]?.value ?? (slots[index] = { deps: [], value: { current: value } }).value) as { current: T }; },
    useState<T>(value?: T) { const index = cursor++; if (!slots[index]) slots[index] = { deps: [], value }; return [slots[index]!.value, () => {}]; },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++, previous = slots[index];
      if (!previous || !same(previous.deps, deps)) pending.push({ index, deps, effect });
    },
  };
  return {
    render(bridge: Pick<DesktopBridge, "subscribeWindowClose" | "answerWindowClose">) {
      cursor = 0; pending = [];
      const previous = internals.H; internals.H = dispatcher;
      try { useWindowClose(bridge, root, async () => true); } finally { internals.H = previous; }
      for (const item of pending) slots[item.index]?.cleanup?.();
      for (const item of pending) {
        const cleanup = item.effect();
        slots[item.index] = { deps: item.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
      }
    },
    dispose() { for (const slot of slots) slot.cleanup?.(); },
  };
}

test("close readiness follows the active subscription across registration, replacement, and cleanup", () => {
  const owner = { dataset: { windowCloseReady: "stale" }, inert: false } as unknown as HTMLElement;
  const root = { current: owner }, events: string[] = [];
  const hooks = driver(root);
  const bridge = (name: string) => ({
    subscribeWindowClose: () => {
      expect(owner.dataset.windowCloseReady).toBeUndefined();
      events.push(`subscribe:${name}`);
      return () => events.push(`unsubscribe:${name}`);
    },
    answerWindowClose: async () => {},
  });

  hooks.render({});
  expect(owner.dataset.windowCloseReady).toBeUndefined();
  hooks.render(bridge("first"));
  expect(owner.dataset.windowCloseReady).toBe("true");
  hooks.render(bridge("second"));
  expect(events).toEqual(["subscribe:first", "unsubscribe:first", "subscribe:second"]);
  expect(owner.dataset.windowCloseReady).toBe("true");
  hooks.dispose();
  expect(events.at(-1)).toBe("unsubscribe:second");
  expect(owner.dataset.windowCloseReady).toBeUndefined();
});
