import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { NativeSessionRecovery } from "./session-recovery";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-recovery-")); roots.push(root);
  const manager = SessionManager.create(root, path.join(root, "sessions")); await manager.ensureOnDisk();
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let provider = "provider-old", retry = true, fresh = true;
  const session = {
    sessionManager: manager,
    subscribe(fn: (event: AgentSessionEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    async retry() { return retry; },
    freshSession() { if (!fresh) return undefined; const previousSessionId = provider; provider = "provider-new"; return { previousSessionId, sessionId: provider, closedProviderSessions: 1 }; },
  };
  return { root, manager, session, controller: new NativeSessionRecovery(session as never, manager, () => {}),
    emit: (event: AgentSessionEvent) => listeners.forEach(listener => listener(event)), setRetry: (value: boolean) => retry = value, setFresh: (value: boolean) => fresh = value };
}

test("retry persists a distinct receipt, waits for the scheduled turn, and Stop settles without false success", async () => {
  const f = await fixture();
  try {
    const stop = new AbortController();
    const result = await f.controller.dispatch("retry", "", stop.signal);
    expect(result).toMatchObject({ handledCommand: "retry", agentInvoked: true, output: "Retrying the last failed turn." });
    let settled = false; void result.turnCompletion!.then(() => settled = true); await Bun.sleep(1); expect(settled).toBe(false);
    f.emit({ type: "agent_start" } as AgentSessionEvent); f.emit({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
    expect(await result.turnCompletion).toBe(true);
    const stopped = await f.controller.dispatch("retry", "", stop.signal); stop.abort(); expect(await stopped.turnCompletion).toBe(false);
    expect(await readFile(f.manager.getSessionFile()!, "utf8")).toContain("Retrying the last failed turn.");
    f.setRetry(false); await expect(f.controller.dispatch("retry", "", new AbortController().signal)).rejects.toThrow("Nothing to retry");
  } finally { await f.manager.close(); }
});

test("fresh rotates only provider identity and records the actual native outcome", async () => {
  const f = await fixture();
  try {
    const file = f.manager.getSessionFile();
    const result = await f.controller.dispatch("fresh", "", new AbortController().signal);
    expect(result).toMatchObject({ handledCommand: "fresh", agentInvoked: false, output: "Fresh provider session started (1 provider state pruned)." });
    expect(f.manager.getSessionFile()).toBe(file);
    const saved = await readFile(file!, "utf8"); expect(saved).toContain('"previousProviderSessionId":"provider-old"'); expect(saved).toContain('"providerSessionId":"provider-new"');
    await expect(f.controller.dispatch("fresh", "unexpected", new AbortController().signal)).rejects.toThrow("Usage: /fresh");
    f.setFresh(false); await expect(f.controller.dispatch("fresh", "", new AbortController().signal)).rejects.toThrow("Wait for the current response");
  } finally { await f.manager.close(); }
});
