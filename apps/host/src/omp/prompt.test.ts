import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { beginNativePrompt } from "./prompt";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function nativeManager() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-desktop-omp-contract-"));
  directories.push(directory);
  const manager = SessionManager.create(directory, path.join(directory, "sessions"));
  await manager.ensureOnDisk();
  return manager;
}

// Real native storage plus explicitly supplied dispatch fixtures; this suite
// proves admission/storage contracts, never live provider execution.
describe("native prompt admission contract", () => {
  test("acknowledges a user entry on disk before provider completion", async () => {
    const manager = await nativeManager();
    const providerCompletion = Promise.withResolvers<boolean>();
    try {
      const run = beginNativePrompt(manager, async () => {
        manager.appendMessage({ role: "user", content: "contract input", timestamp: 1 });
        return { agentInvoked: await providerCompletion.promise };
      }, async () => {});
      const receipt = await run.accepted;
      expect(receipt?.kind).toBe("user-message");
      if (receipt?.kind !== "user-message") throw new Error("Expected actual native user entry");
      expect(receipt.entryId).toBeString();
      const lines = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(lines.some(entry => entry.id === receipt!.entryId && entry.message.content === "contract input")).toBe(true);
      providerCompletion.resolve(true);
      expect(await run.completion).toBe(true);
    } finally { providerCompletion.resolve(false); await manager.close(); }
  });

  test("a preflight rejection rejects admission and restores the native observer", async () => {
    const manager = await nativeManager();
    const observer = () => {};
    manager.onEntryAppended = observer;
    try {
      const run = beginNativePrompt(manager, async () => { throw new Error("contract preflight failure"); }, async () => {});
      await expect(run.accepted).rejects.toThrow("contract preflight failure");
      await expect(run.completion).rejects.toThrow("contract preflight failure");
      expect(manager.onEntryAppended).toBe(observer);
    } finally { await manager.close(); }
  });

  test("native true/false completion without a user entry never acknowledges a draft", async () => {
    const manager = await nativeManager();
    try {
      for (const nativeResult of [true, false]) {
        const run = beginNativePrompt(manager, async () => ({ agentInvoked: nativeResult }), async () => {});
        expect(await run.accepted).toBeNull();
        expect(await run.completion).toBe(nativeResult);
      }
    } finally { await manager.close(); }
  });

  test("a flush failure never becomes an acceptance receipt", async () => {
    const manager = await nativeManager();
    const storage = {
      onEntryAppended: manager.onEntryAppended,
      flush: async () => { throw new Error("contract storage failure"); },
    };
    try {
      const run = beginNativePrompt(storage, async () => {
        const id = manager.appendMessage({ role: "user", content: "contract input", timestamp: 1 });
        storage.onEntryAppended?.(manager.getEntry(id)!);
        return { agentInvoked: true };
      }, async () => {});
      await expect(run.accepted).rejects.toThrow("contract storage failure");
      await expect(run.completion).rejects.toThrow("contract storage failure");
    } finally { await manager.close(); }
  });

  test("handled command acknowledgement waits for persistence and never creates a user message", async () => {
    const manager = await nativeManager();
    const settle = Promise.withResolvers<void>();
    try {
      const run = beginNativePrompt(manager, async () => {
        manager.appendCustomEntry("contract-command-side-effect", {});
        return { agentInvoked: false, handledCommand: "contract-command" };
      }, () => settle.promise);
      let accepted = false; void run.accepted.then(() => { accepted = true; });
      await Promise.resolve(); expect(accepted).toBe(false);
      settle.resolve();
      expect(await run.accepted).toEqual({ kind: "native-command", command: "contract-command" });
      expect(await run.completion).toBe(false);
      expect(manager.getEntries().some(entry => entry.type === "message")).toBe(false);
    } finally { settle.resolve(); await manager.close(); }
  });

  test("local command persistence failure rejects its receipt", async () => {
    const storage = { onEntryAppended: undefined, flush: async () => { throw new Error("command disk failure"); } };
    const run = beginNativePrompt(storage, async () => ({ agentInvoked: false, handledCommand: "contract-command" }), async () => {});
    await expect(run.accepted).rejects.toThrow("command disk failure");
    await expect(run.completion).rejects.toThrow("command disk failure");
  });
});
