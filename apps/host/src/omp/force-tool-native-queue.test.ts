import { describe, expect, test } from "bun:test";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import type { ToolChoice } from "@oh-my-pi/pi-ai";

const named: ToolChoice = { type: "function", name: "force_fixture" };

describe("native force queue observation and exact cancellation", () => {
  test("immutable snapshots do not advance opaque iterators, consume labels, or execute callbacks", () => {
    const queue = new ToolChoiceQueue();
    let advances = 0, callbacks = 0;
    queue.push((function* () { advances++; yield named; advances++; yield "none"; })(), { label: "opaque", onResolved: () => { callbacks++; } });
    const before = queue.snapshot();
    expect(before.directives[0]?.sequence).toBeUndefined();
    expect(queue.snapshot()).toEqual(before);
    expect(advances).toBe(0); expect(callbacks).toBe(0);
    queue.nextToolChoice(); queue.resolve();
    queue.snapshot(); queue.snapshot();
    expect(advances).toBe(1); expect(callbacks).toBe(1);
    expect(queue.consumeLastServedLabel()).toBe("opaque");
    const choice: ToolChoice = { type: "function", function: { name: "original" } };
    const values: ToolChoice[] = [choice, "none"];
    let callbackChoice: ToolChoice | undefined;
    const id = queue.pushSequence(values, { now: true, onResolved: info => { callbackChoice = info.choice; } });
    const snapshot = queue.snapshot().directives.find(entry => entry.id === id)!;
    expect(Object.isFrozen(snapshot.sequence)).toBe(true);
    expect(Object.isFrozen(snapshot.sequence![0])).toBe(true);
    const snapshotChoice = snapshot.sequence![0];
    if (!snapshotChoice || typeof snapshotChoice === "string" || !("function" in snapshotChoice)) throw new Error("Expected named metadata");
    expect(() => { snapshotChoice.function.name = "read mutation"; }).toThrow();
    expect(queue.nextToolChoice()).toBe(choice);
    queue.resolve(); expect(callbackChoice).toBe(choice);
    expect(queue.nextToolChoice()).toBe("none");
  });

  test("error and abort replays retain one root ID and the original consumed step", () => {
    const queue = new ToolChoiceQueue();
    const events: string[] = [];
    queue.subscribe(event => { events.push(event.type); });
    const id = queue.pushSequence([named, "none"], { label: "user-force", onRejected: info => info.reason === "unavailable" ? "drop_sequence" : "requeue" });
    for (const reason of ["error", "aborted"] as const) {
      expect(queue.nextToolChoice()).toEqual(named);
      expect(queue.snapshot().directives).toEqual([{ id, label: "user-force", sequence: [named, "none"], nextIndex: 1, inFlightIndex: 0, requeued: reason === "aborted" }]);
      queue.reject(reason);
      const pending = queue.snapshot().directives;
      expect(pending).toEqual([{ id, label: "user-force", sequence: [named, "none"], nextIndex: 0, requeued: true }]);
    }
    expect(queue.nextToolChoice()).toEqual(named); queue.resolve();
    expect(queue.snapshot().directives[0]).toMatchObject({ id, nextIndex: 1, requeued: true });
    expect(queue.nextToolChoice()).toBe("none"); queue.reject("error");
    expect(queue.snapshot().directives[0]).toMatchObject({ id, nextIndex: 1, requeued: true });
    expect(queue.nextToolChoice()).toBe("none"); queue.resolve();
    expect(queue.snapshot().directives).toEqual([]);
    expect(events.filter(event => event === "push")).toEqual(["push"]);
    expect(events.filter(event => event === "reject")).toEqual(["reject", "reject", "reject"]);
  });

  test("unavailable drops replay and entire remaining sequence without touching another force", () => {
    const queue = new ToolChoiceQueue();
    const first = queue.pushSequence([named, "none"], { label: "user-force", onRejected: info => info.reason === "unavailable" ? "drop_sequence" : "requeue" });
    const second = queue.pushSequence([{ type: "function", name: "second" }, "none"], { label: "user-force" });
    queue.nextToolChoice(); queue.reject("error"); queue.nextToolChoice(); queue.reject("unavailable");
    expect(queue.snapshot().directives.map(entry => entry.id)).toEqual([second]);
    expect(queue.removeSequence(first)).toBe(false);
    expect(queue.nextToolChoice()).toEqual({ type: "function", name: "second" });
  });

  test("exact cancellation covers replay children, leaves preview/eager/other force order intact", () => {
    const queue = new ToolChoiceQueue();
    let previews = 0, resolved = 0;
    const first = queue.pushSequence([named, "none"], { label: "user-force", onRejected: () => "requeue", onResolved: () => { resolved++; } });
    const second = queue.pushSequence([{ type: "function", name: "second" }, "none"], { label: "user-force" });
    const eager = queue.pushOnce("required", { label: "eager-todo" });
    queue.registerPendingInvoker("preview", "edit", () => { previews++; });
    queue.nextToolChoice(); expect(queue.removeSequence(first)).toBe(false);
    queue.reject("aborted"); expect(queue.removeSequence(first)).toBe(true);
    expect(queue.snapshot().directives.map(entry => entry.id)).toEqual([second, eager]);
    expect(queue.peekPendingHead()).toEqual({ id: "preview", sourceToolName: "edit" });
    expect(previews).toBe(0); expect(resolved).toBe(0);
    expect(queue.nextToolChoice()).toEqual({ type: "function", name: "second" }); queue.resolve();
    expect(queue.nextToolChoice()).toBe("none"); queue.resolve();
    expect(queue.nextToolChoice()).toBe("required"); queue.resolve();
    expect(queue.consumeLastServedLabel()).toBe("eager-todo");
  });

  test("observer failures cannot replace lifecycle callbacks, including throwing callbacks", () => {
    const queue = new ToolChoiceQueue();
    const callbackError = new Error("native callback");
    const ordering: string[] = [];
    queue.subscribe(event => { ordering.push(event.type); throw new Error("observer"); });
    queue.pushOnce(named, { onResolved: () => { ordering.push("callback"); throw callbackError; } });
    queue.nextToolChoice(); expect(() => queue.resolve()).toThrow(callbackError);
    expect(ordering).toEqual(["push", "claim", "callback", "resolve"]);
    expect(queue.hasInFlight).toBe(false);
    const before = queue.snapshot().revision; queue.clear();
    expect(queue.snapshot()).toEqual({ revision: before + 1, directives: [], hasInFlight: false });
  });
});
