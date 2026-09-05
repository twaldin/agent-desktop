import { describe, expect, test } from "bun:test";
import type { DesktopEvent, OmpInteractionResponse } from "../../../../packages/shared/src/protocol";
import { OmpInteractionBridge } from "../../../host/src/omp/interactions";
import { InteractionsState, type InteractionBridge } from "./interactions-state";

function fixture() {
  const listeners = new Set<(event: DesktopEvent) => void>();
  const deliveries: OmpInteractionResponse[] = [];
  const owners: Array<string | undefined> = [];
  const native = new OmpInteractionBridge("session", () => { for (const listener of listeners) listener({ type: "interactions", sequence: 1, hostId: "work", sessionId: "session" }); });
  const bridge: InteractionBridge = {
    getInteractions: async (sessionId, hostId) => { expect(sessionId).toBe("session"); owners.push(hostId); return native.list(); },
    respondInteraction: async (sessionId, id, response, hostId) => { expect(sessionId).toBe("session"); owners.push(hostId); deliveries.push(response); native.respond(id, response); },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { data: new InteractionsState(bridge, "work", "session", "local"), native, deliveries, owners, listeners };
}

describe("renderer with the production native OMP interaction bridge (no provider)", () => {
  test("No and Cancel settle native confirmations as false", async () => {
    const { data, native, deliveries, owners } = fixture();
    const declined = native.confirm("Confirm", "Continue?"); await data.refresh();
    await data.respond(data.requests[0]!.id, { value: false });
    expect(await declined).toBe(false); expect(deliveries[0]).toEqual({ value: false });
    const cancelled = native.confirm("Confirm again", "Continue?"); await data.refresh();
    await data.respond(data.requests[0]!.id, { cancel: true });
    expect(await cancelled).toBe(false); expect(data.requests).toEqual([]);
    expect(owners.every(owner => owner === "work")).toBe(true); native.dispose();
  });
  test("select answers use exact native labels and invalid answers never reach the host", async () => {
    const { data, native, deliveries } = fixture();
    const selected = native.select("Choose", [{ label: "One", description: "First" }, "Two"], { initialIndex: 1, selectionMarker: "checkbox", checkedIndices: [0], markableCount: 2 });
    await data.refresh(); const request = data.requests[0]!;
    expect(request).toMatchObject({ initialIndex: 1, selectionMarker: "checkbox", checkedIndices: [0], markableCount: 2 });
    await data.respond(request.id, { value: "invented" }); expect(deliveries).toHaveLength(0);
    await data.respond(request.id, { value: "Two" }); expect(await selected).toBe("Two"); native.dispose();
  });
  test("editor/input content passes through while pending snapshots never retain answers", async () => {
    const { data, native } = fixture();
    const edited = native.editor("Edit", "Native prefill", { helpText: "Native help" }, { promptStyle: true }); await data.refresh();
    expect(data.requests[0]).toMatchObject({ prefill: "Native prefill", helpText: "Native help", promptStyle: true });
    await data.respond(data.requests[0]!.id, { value: "Edited\nanswer" }); expect(await edited).toBe("Edited\nanswer");
    const entered = native.input("Answer", "Placeholder"); await data.refresh();
    await data.respond(data.requests[0]!.id, { value: "Private answer" }); expect(await entered).toBe("Private answer");
    expect(data.requests).toEqual([]); expect(JSON.stringify(data)).not.toContain("Private answer"); native.dispose();
  });
  test("a competing response cannot be overwritten and triggers a fresh pending list", async () => {
    const { data, native } = fixture();
    const confirmation = native.confirm("Shared request", "Continue?"); await data.refresh(); const id = data.requests[0]!.id;
    native.respond(id, { value: false });
    await data.respond(id, { value: true });
    expect(await confirmation).toBe(false); expect(data.responseError).toContain("no longer pending"); expect(data.requests).toEqual([]); native.dispose();
  });
  test("advertised editor callbacks remain pending while native navigation settles the request", async () => {
    const { data, native, deliveries } = fixture(); let edits = 0; let previous = 0;
    const selected = native.select("Navigate", ["Choice"], { onExternalEditor: () => edits++, onLeft: () => previous++ }); await data.refresh(); const id = data.requests[0]!.id;
    await data.respond(id, { action: "right" }); expect(deliveries).toHaveLength(0);
    await data.respond(id, { action: "externalEditor" }); expect(edits).toBe(1); expect(data.requests).toHaveLength(1);
    await data.respond(id, { action: "left" }); expect(previous).toBe(1); expect(await selected).toBeUndefined(); expect(data.requests).toEqual([]); native.dispose();
  });
  test("native timeout resolves without any automatic client consent or answer", async () => {
    const { data, native, deliveries } = fixture();
    const expired = native.confirm("Timeout", "No automatic consent", { timeout: 15 }); await data.refresh();
    expect(data.requests[0]?.actions).toContain("timeoutReset"); expect(data.requests[0]?.expiresAt).toBeDefined();
    expect(await expired).toBe(false); await data.refresh();
    expect(deliveries).toHaveLength(0); expect(data.requests).toEqual([]); native.dispose();
  });
  test("foreign host/session invalidations do not read or replace this request list", async () => {
    const { data, native, listeners, owners } = fixture(); data.start();
    for (const listener of listeners) { listener({ type: "interactions", sequence: 1, hostId: "other", sessionId: "session" }); listener({ type: "interactions", sequence: 2, hostId: "work", sessionId: "other-session" }); }
    expect(owners).toHaveLength(0); data.stop(); native.dispose();
  });
});
