import { describe, expect, test } from "bun:test";
import { OmpInteractionBridge, UnsupportedOmpUIError, type OmpBridgeEvent } from "./interactions";

describe("native ExtensionUIContext callback contracts (no provider)", () => {
  test("real answers are type checked, one-use and absent from events", async () => {
    const events: OmpBridgeEvent[] = [];
    const ui = new OmpInteractionBridge("contract-session", event => events.push(event));
    const selection = ui.select("Choose", ["One", { label: "Two", description: "Second" }]);
    const id = ui.list()[0].id;
    expect(() => ui.respond(id, { value: "invented" })).toThrow("not a native OMP option");
    expect(ui.list()).toHaveLength(1);
    ui.respond(id, { value: "Two" });
    expect(await selection).toBe("Two");
    expect(() => ui.respond(id, { value: "One" })).toThrow("no longer pending");
    const confirmed = ui.confirm("Permission", "Allow this specific operation?");
    expect(() => ui.respond(ui.list()[0].id, { value: "true" })).toThrow("Wrong value type");
    ui.respond(ui.list()[0].id, { cancel: true });
    expect(await confirmed).toBe(false);
    const text = ui.input("Private answer");
    ui.respond(ui.list()[0].id, { value: "fixture-private-answer" });
    expect(await text).toBe("fixture-private-answer");
    expect(JSON.stringify(events)).not.toContain("fixture-private-answer");
    expect(ui.list()).toEqual([]);
  });

  test("timeout, abort, disconnect and disposal cancel without approval", async () => {
    const events: OmpBridgeEvent[] = [];
    const ui = new OmpInteractionBridge("contract-session", event => events.push(event));
    let timeouts = 0;
    let started = 0;
    const timed = ui.confirm("Timeout", "No automatic consent", { timeout: 10, onTimeout: () => timeouts++, onTimeoutStart: () => started++ });
    expect(ui.list()[0].expiresAt).toBeGreaterThanOrEqual(Date.now());
    expect(await timed).toBe(false);
    expect(timeouts).toBe(1); expect(started).toBe(1);
    const controller = new AbortController();
    const aborted = ui.editor("Abort", "original", { signal: controller.signal });
    controller.abort();
    expect(await aborted).toBeUndefined();
    const disconnected = ui.confirm("Disconnect", "No consent");
    ui.cancelAll("disconnected");
    expect(await disconnected).toBe(false);
    const disposed = ui.input("Dispose");
    ui.dispose();
    expect(await disposed).toBeUndefined();
    await expect(ui.input("After dispose")).rejects.toThrow("disposed");
    expect(events.filter(event => event.type === "extension_interaction_resolved").map(event => event.reason)).toEqual(["timeout", "aborted", "disconnected", "disposed"]);
  });

  test("native selector navigation settles while external-editor callbacks remain pending", async () => {
    const ui = new OmpInteractionBridge("contract-session", () => {});
    let left = 0;
    let external = 0;
    const selected = ui.select("Callback", ["Label"], { onLeft: () => left++, onExternalEditor: () => external++ });
    const request = ui.list()[0];
    expect(request.actions).toEqual(["left", "externalEditor"]);
    ui.respond(request.id, { action: "externalEditor" });
    expect(external).toBe(1); expect(ui.list()).toHaveLength(1);
    expect(() => ui.respond(request.id, { action: "right" })).toThrow("Unsupported action");
    ui.respond(request.id, { action: "left" });
    expect(left).toBe(1); expect(await selected).toBeUndefined(); expect(ui.list()).toEqual([]);
    await expect(ui.custom()).rejects.toBeInstanceOf(UnsupportedOmpUIError);
    expect(() => ui.getEditorText()).toThrow("not supported");
  });
});
