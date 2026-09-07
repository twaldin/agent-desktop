import { describe, expect, test } from "bun:test";
import { WindowCloseGate, type WindowCloseRequest } from "./window-close";

function fixture() {
  const sent: Array<{senderId:number;request:WindowCloseRequest}> = [];
  const unavailable: Array<{senderId:number;reason:string}> = [];
  const timers: Array<() => void> = [];
  let sequence = 0;
  const gate = new WindowCloseGate({
    send: (senderId, request) => sent.push({senderId, request}),
    unavailable: (senderId, reason) => unavailable.push({senderId, reason}),
    id: () => `request-${++sequence}`,
    schedule: callback => { timers.push(callback); return () => {}; },
  });
  return {gate, sent, unavailable, timers};
}

describe("window close preparation", () => {
  test("deduplicates concurrent close attempts and accepts only the current sender-scoped reply", async () => {
    const {gate, sent} = fixture(); gate.register(7);
    let closed = 0;
    expect(gate.handleWindowClose(7, () => closed++)).toBe(false);
    expect(gate.handleWindowClose(7, () => closed++)).toBe(false);
    expect(sent).toEqual([{senderId: 7, request: {id: "request-1"}}]);
    expect(gate.answer(8, "request-1", true)).toBe(false);
    expect(gate.answer(7, "stale", true)).toBe(false);
    expect(gate.answer(7, "request-1", true)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(1);
    expect(gate.handleWindowClose(7, () => closed++)).toBe(true);
    expect(gate.answer(7, "request-1", true)).toBe(false);
  });

  test("a refusal keeps the window open and a later close gets a fresh request", async () => {
    const {gate, sent} = fixture(); gate.register(2);
    let closed = 0;
    gate.handleWindowClose(2, () => closed++);
    gate.answer(2, "request-1", false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(0);
    gate.handleWindowClose(2, () => closed++);
    expect(sent.at(-1)?.request).toEqual({id: "request-2"});
  });

  test("timeout cancels preparation, reports a native error, and never grants a stale permit", async () => {
    const {gate, sent, unavailable, timers} = fixture(); gate.register(3);
    const pending = gate.request(3); timers[0]!();
    await expect(pending).resolves.toBe(false);
    expect(sent).toEqual([
      {senderId: 3, request: {id: "request-1"}},
      {senderId: 3, request: {id: "request-1", cancelled: true}},
    ]);
    expect(unavailable).toEqual([{senderId: 3, reason: "timeout"}]);
    expect(gate.answer(3, "request-1", true)).toBe(false);
  });

  test("unready renderers never bypass recovery and navigation cancels a live request", async () => {
    const {gate, sent, unavailable} = fixture();
    await expect(gate.request(4)).resolves.toBe(false);
    expect(unavailable).toEqual([{senderId: 4, reason: "renderer-unavailable"}]);
    gate.register(4); const pending = gate.request(4); gate.unregister(4);
    await expect(pending).resolves.toBe(false);
    expect(sent.at(-1)).toEqual({senderId: 4, request: {id: "request-1", cancelled: true}});
    expect(unavailable.at(-1)).toEqual({senderId: 4, reason: "renderer-unavailable"});
  });

  test("quit waits for every window, cancellation preserves all, and a repeat may succeed", async () => {
    const {gate, sent} = fixture(); gate.register(1); gate.register(2);
    let quits = 0;
    gate.requestQuit([1, 2], () => quits++);
    gate.requestQuit([1, 2], () => quits++);
    expect(sent.map(item => item.senderId)).toEqual([1, 2]);
    gate.answer(1, "request-1", true); gate.answer(2, "request-2", false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(quits).toBe(0); expect(gate.consumeQuitPermit()).toBe(false);
    expect(sent.at(-1)).toEqual({senderId: 1, request: {id: "request-1", cancelled: true}});

    gate.requestQuit([1, 2], () => quits++);
    gate.answer(1, "request-3", true); gate.answer(2, "request-4", true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(quits).toBe(1); expect(gate.consumeQuitPermit()).toBe(true); expect(gate.consumeQuitPermit()).toBe(false);
    expect(gate.handleWindowClose(1, () => {})).toBe(true);
    expect(gate.handleWindowClose(2, () => {})).toBe(true);
  });

  test("an approval from before a renderer reload cannot permit the reloaded window to quit", async () => {
    const {gate, sent, unavailable} = fixture(); gate.register(1); gate.register(2);
    let quits = 0; gate.requestQuit([1, 2], () => quits++);
    gate.answer(1, "request-1", true);
    gate.unregister(1); gate.register(1);
    gate.answer(2, "request-2", true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(quits).toBe(0); expect(gate.consumeQuitPermit()).toBe(false);
    expect(sent.slice(-2)).toEqual([
      {senderId: 1, request: {id: "request-1", cancelled: true}},
      {senderId: 2, request: {id: "request-2", cancelled: true}},
    ]);
    expect(unavailable.at(-1)).toEqual({senderId: 1, reason: "renderer-unavailable"});
  });
});
