import { expect, test } from "bun:test";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { createNativeAccountSelectionBridge } from "./session-selection";

function nativeBoundary() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let model = { provider: "native", id: "one" }, active = 1;
  const mutations: string[] = [];
  const fixture = {
    sessionId: "original", isStreaming: false, hasPostPromptWork: false,
    get model() { return model; },
    subscribe(listener: (event: AgentSessionEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    listCurrentProviderOAuthAccounts: async () => ({ provider: model.provider, accounts: [1, 2].map(credentialId => ({ credentialId, active: credentialId === active, position: credentialId - 1 })) }),
    pinCurrentProviderOAuthAccount(id: number) { mutations.push(`pin:${model.provider}:${id}`); if (![1, 2].includes(id)) return false; active = id; return true; },
    modelRegistry: { authStorage: { getOAuthAccountIdentity: () => undefined, releaseSessionCredentialForReselection(provider: string, id: string) { mutations.push(`release:${provider}:${id}`); active = 0; } } },
    sessionManager: { flush: async () => { mutations.push("flush"); } },
  };
  return { fixture, session: fixture as unknown as AgentSession, mutations, listeners, change(next: typeof model) { model = next; for (const listener of listeners) listener({ type: "model_changed" }); }, activity(id: number) { active = id; } };
}
test("original model ABA and replacement worker cannot consume a captured selection", async () => {
  const f = nativeBoundary(), first = createNativeAccountSelectionBridge(async () => f.session);
  const before = await first.list("original");
  f.change({ provider: "other", id: "two" }); f.change({ provider: "native", id: "one" });
  await expect(first.release("original", before.selection)).rejects.toThrow("selection changed");
  const second = createNativeAccountSelectionBridge(async () => f.session);
  await expect(second.pin("original", 2, before.selection)).rejects.toThrow("selection changed");
  expect(f.mutations).toEqual([]); first.dispose(); second.dispose(); expect(f.listeners.size).toBe(0);
});
test("model replacement during held credential refresh rejects before pin or release", async () => {
  for (const operation of ["pin", "release"] as const) {
    const f = nativeBoundary(); let gate: Promise<void> | undefined;
    const owner = createNativeAccountSelectionBridge(async () => f.session, { revalidate: async () => { await gate; } });
    const initial = await owner.list("original"), held = Promise.withResolvers<void>(); gate = held.promise;
    const pending = operation === "pin" ? owner.pin("original", 2, initial.selection) : owner.release("original", initial.selection);
    await Promise.resolve(); await Promise.resolve(); f.change({ provider: "other", id: "two" }); held.resolve();
    await expect(pending).rejects.toThrow("selection changed"); expect(f.mutations).toEqual([]); owner.dispose();
  }
});
test("pin receipt advances token, release uses new selection, unrelated owner remains isolated", async () => {
  const f = nativeBoundary(), other = nativeBoundary(), owner = createNativeAccountSelectionBridge(async () => f.session), independent = createNativeAccountSelectionBridge(async () => other.session);
  const before = await owner.list("original"), otherBefore = await independent.list("original");
  const pinned = await owner.pin("original", 2, before.selection);
  expect(pinned.accounts.find(account => account.active)?.credentialId).toBe(2);
  await expect(owner.release("original", before.selection)).rejects.toThrow("selection changed");
  const released = await owner.release("original", pinned.selection);
  expect(released.accounts.some(account => account.active)).toBe(false);
  expect(f.mutations).toEqual(["pin:native:2", "flush", "release:native:original"]);
  expect((await independent.list("original")).selection).toEqual(otherBefore.selection); expect(other.mutations).toEqual([]);
  owner.dispose(); independent.dispose();
});
test("externally changed active account requires fresh deliberate selection", async () => {
  const f = nativeBoundary(), owner = createNativeAccountSelectionBridge(async () => f.session), before = await owner.list("original");
  f.activity(2); await expect(owner.release("original", before.selection)).rejects.toThrow("selection changed"); expect(f.mutations).toEqual([]);
  const fresh = await owner.list("original"); await owner.release("original", fresh.selection); expect(f.mutations).toEqual(["release:native:original"]); owner.dispose();
});
test("busy, disposed and flush-failed selection never reports clean success", async () => {
  const f = nativeBoundary(), owner = createNativeAccountSelectionBridge(async () => f.session), before = await owner.list("original");
  f.fixture.isStreaming = true; await expect(owner.pin("original", 2, before.selection)).rejects.toThrow("running"); expect(f.mutations).toEqual([]);
  f.fixture.isStreaming = false; f.fixture.sessionManager.flush = async () => { throw new Error("Native journal flush failed"); };
  await expect(owner.pin("original", 2, before.selection)).rejects.toThrow("journal flush failed");
  await expect(owner.pin("original", 2, before.selection)).rejects.toThrow("selection changed"); expect(f.mutations).toEqual(["pin:native:2"]);
  owner.dispose(); await expect(owner.list("original")).rejects.toThrow("closed");
});

test("native selector labels preserve same-email organization identity", async () => {
  const { sessionAccount } = await import("./projection");
  const first = sessionAccount("native", { credentialId: 1, position: 0, active: true, email: "account@example.invalid", orgName: "First organization" });
  const second = sessionAccount("native", { credentialId: 2, position: 1, active: false, email: "account@example.invalid", orgName: "Second organization" });
  expect(first.label).toBe("account@example.invalid (First organization)");
  expect(second.label).toBe("account@example.invalid (Second organization)");
});
