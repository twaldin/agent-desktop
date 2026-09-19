import { describe, expect, test } from "bun:test";
import { OmpInteractionBridge, UnsupportedOmpUIError, type OmpBridgeEvent } from "./interactions";

describe("native ExtensionUIContext callback contracts (no provider)", () => {
  test("permission markers apply once and can be cancelled before another question", () => {
    const ui = new OmpInteractionBridge("contract-session", () => {});
    const clear = ui.markNextInteractionAsPermission();
    const permission = ui.select("Native approval", ["Approve", "Deny"]);
    expect(ui.list()[0]?.notificationKind).toBe("permission");
    clear(); ui.respond(ui.list()[0]!.id, { value: "Deny" }); void permission;
    const unused = ui.markNextInteractionAsPermission(); unused();
    const generic = ui.confirm("Generic confirm", "This is still a question");
    expect(ui.list()[0]?.notificationKind).toBeUndefined();
    ui.respond(ui.list()[0]!.id, { value: false }); void generic;
  });

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

describe("native reset decision binding", () => {
  test("binds the allocated select id before publication and records the native answer once", async () => {
    const events: OmpBridgeEvent[] = [];
    const bound = Promise.withResolvers<void>();
    let boundId = "";
    let selections = 0;
    const ui = new OmpInteractionBridge("decision-session", event => events.push(event));
    const decision = ui.runWithDecisionBinding(async id => { boundId = id; await bound.promise; }, async () => {
      selections++;
      return ui.select("Native decision", ["Yes", "No"]);
    });
    await Promise.resolve();
    expect(boundId).not.toBe("");
    expect(ui.list()).toEqual([]);
    expect(events).toEqual([]);
    bound.resolve();
    for (let index = 0; index < 20 && ui.list().length === 0; index++) await Bun.sleep(0);
    expect(ui.list().map(item => item.id)).toEqual([boundId]);
    expect(events.filter(event => event.type === "extension_interaction_requested")).toHaveLength(1);
    ui.respond(boundId, { value: "No" });
    expect(await decision).toBe("No");
    expect(selections).toBe(1);
  });

  test("rejects zero, non-select and duplicate interactions without publishing a decision", async () => {
    const ui = new OmpInteractionBridge("decision-session", () => {});
    await expect(ui.runWithDecisionBinding(async () => {}, async () => "no selection")).rejects.toThrow("exactly one select");
    await expect(ui.runWithDecisionBinding(async () => {}, () => ui.confirm("Wrong", "Not a select"))).rejects.toThrow("exactly one select");
    await expect(ui.runWithDecisionBinding(async () => {}, async () => {
      const first = ui.select("First", ["A"]); void first.catch(() => {});
      const second = ui.select("Second", ["B"]); void second.catch(() => {});
      return Promise.all([first, second]);
    })).rejects.toThrow("exactly one select");
    expect(ui.list()).toEqual([]);

    const duplicate = Promise.withResolvers<void>();
    const delayed = ui.runWithDecisionBinding(async () => {}, async () => {
      const first = ui.select("Published first", ["A"]); void first.catch(() => {});
      await duplicate.promise;
      const second = ui.select("Late duplicate", ["B"]); void second.catch(() => {});
      return Promise.all([first, second]);
    });
    for (let index = 0; index < 20 && ui.list().length === 0; index++) await Bun.sleep(0);
    expect(ui.list()).toHaveLength(1);
    duplicate.resolve();
    await expect(delayed).rejects.toThrow("exactly one select");
    expect(ui.list()).toEqual([]);
  });

  test("cancellation and binding failure while binding prevent late publication", async () => {
    for (const stop of ["cancel", "dispose", "abort"] as const) {
      const events: OmpBridgeEvent[] = [];
      const binding = Promise.withResolvers<void>();
      const controller = new AbortController();
      const ui = new OmpInteractionBridge(`decision-${stop}`, event => events.push(event));
      const decision = ui.runWithDecisionBinding(async () => binding.promise, () =>
        ui.select("Native decision", ["Yes", "No"], { signal: controller.signal }));
      let settled = false; void decision.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      if (stop === "cancel") ui.cancelAll();
      else if (stop === "dispose") ui.dispose();
      else controller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      binding.resolve();
      expect(await decision).toBeUndefined();
      expect(ui.list()).toEqual([]);
      expect(events).toEqual([]);
    }

    const ui = new OmpInteractionBridge("decision-failure", () => {});
    const failure = Promise.withResolvers<void>();
    const decision = ui.runWithDecisionBinding(async () => failure.promise, () => ui.select("Native decision", ["Yes", "No"]));
    await Promise.resolve();
    ui.cancelAll();
    failure.reject(new Error("host binding failed"));
    await expect(decision).rejects.toThrow("host binding failed");
    expect(ui.list()).toEqual([]);
  });

  test("already stopped requests never invoke the host binder", async () => {
    let binds = 0;
    const disposed = new OmpInteractionBridge("decision-disposed", () => {});
    disposed.dispose();
    await expect(disposed.runWithDecisionBinding(async () => { binds++; }, () =>
      disposed.select("Native decision", ["Yes", "No"]))).rejects.toThrow("disposed");

    const aborted = new OmpInteractionBridge("decision-aborted", () => {});
    const controller = new AbortController(); controller.abort();
    expect(await aborted.runWithDecisionBinding(async () => { binds++; }, () =>
      aborted.select("Native decision", ["Yes", "No"], { signal: controller.signal }))).toBeUndefined();
    expect(binds).toBe(0);
    expect(disposed.list()).toEqual([]);
    expect(aborted.list()).toEqual([]);
  });

  test("a forgotten select promise cannot outlive its completed binding scope", async () => {
    const events: OmpBridgeEvent[] = [];
    const ui = new OmpInteractionBridge("decision-forgotten", event => events.push(event));
    await expect(ui.runWithDecisionBinding(async () => {}, async () => {
      const forgotten = ui.select("Forgotten", ["Yes", "No"]); void forgotten.catch(() => {});
      for (let index = 0; index < 20 && ui.list().length === 0; index++) await Bun.sleep(0);
      return "returned without awaiting";
    })).rejects.toThrow("must await");
    expect(ui.list()).toEqual([]);
    expect(events.filter(event => event.type === "extension_interaction_requested")).toHaveLength(1);
    expect(events.filter(event => event.type === "extension_interaction_resolved")).toHaveLength(1);
  });

  test("unrelated UI stays unscoped and callbacks retained past scope cannot publish", async () => {
    const ui = new OmpInteractionBridge("decision-session", () => {});
    const invokeLate = Promise.withResolvers<void>();
    let lateResult!: Promise<string | undefined>;
    const scoped = ui.runWithDecisionBinding(async () => {}, async () => {
      lateResult = invokeLate.promise.then(() => ui.select("Late", ["No"]));
      return "scope returned";
    });
    await expect(scoped).rejects.toThrow("exactly one select");
    const ordinary = ui.input("Unrelated");
    expect(ui.list()).toHaveLength(1);
    invokeLate.resolve();
    await expect(lateResult).rejects.toThrow("exactly one select");
    expect(ui.list()).toHaveLength(1);
    ui.respond(ui.list()[0]!.id, { value: "ordinary" });
    expect(await ordinary).toBe("ordinary");
  });
});
