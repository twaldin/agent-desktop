import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createHash } from "node:crypto";
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

  test("scheduled command admission is durable before its actual continuation settles", async () => {
    const manager = await nativeManager();
    const turn = Promise.withResolvers<boolean>();
    try {
      const run = beginNativePrompt(manager, async () => {
        const output = "Retrying the last failed turn.";
        const commandEntryId = manager.appendCustomEntry("agent-desktop.command-output", { command: "retry", output });
        return { agentInvoked: true, handledCommand: "retry", commandEntryId, output, turnCompletion: turn.promise };
      }, async () => {});
      expect(await run.accepted).toMatchObject({ kind: "native-command", command: "retry", output: "Retrying the last failed turn." });
      let settled = false; void run.completion.then(() => { settled = true; }); await Bun.sleep(1); expect(settled).toBe(false);
      turn.resolve(true); expect(await run.completion).toBe(true);
    } finally { turn.resolve(false); await manager.close(); }
  });

  test("image admission skips another user's append and requires its exact native object plus flush", async () => {
    const manager = await nativeManager();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hZkAAAAASUVORK5CYII=", "base64");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const imageMessage = { role: "user" as const, content: [{ type: "text" as const, text: "Image submission identity fixture" },
      { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" }], timestamp: 2 };
    const images = [{ attachmentId: "fixture-image", blockIndex: 1, sourceSha256: digest, nativeSha256: digest, mimeType: "image/png", bytes: bytes.byteLength }];
    let ownId: string | undefined, unrelatedId: string | undefined;
    try {
      // Controlled dispatch with real native image storage, not a provider or
      // normalization proof; actual SDK normalization is covered by worker tests.
      const run = beginNativePrompt(manager, async () => {
        unrelatedId = manager.appendMessage({ role: "user", content: "Unrelated native append", timestamp: 1 });
        ownId = manager.appendMessage(imageMessage);
        return { agentInvoked: true };
      }, async () => {}, { matches: message => message === imageMessage, receipt: () => images, dispatched: true });
      expect(await run.accepted).toEqual({ kind: "user-message", entryId: ownId!, images });
      expect(ownId).not.toBe(unrelatedId);
      expect(await run.completion).toBe(true);
    } finally { await manager.close(); }
  });

  test("selected-text admission skips an interleaved user append and requires its captured native object", async () => {
    const manager = await nativeManager();
    const selectedMessage = { role: "user" as const, content: "Selected-text authored prompt", timestamp: 2 };
    let ownId: string | undefined, unrelatedId: string | undefined;
    try {
      const run = beginNativePrompt(manager, async () => {
        unrelatedId = manager.appendMessage({ role: "user", content: "Extension interleaved user append", timestamp: 1 });
        ownId = manager.appendMessage(selectedMessage);
        return { agentInvoked: true };
      }, async () => {}, undefined, undefined, { attempted: true, matches: message => message === selectedMessage });
      expect(await run.accepted).toEqual({ kind: "user-message", entryId: ownId! });
      expect(ownId).not.toBe(unrelatedId);
      expect(await run.completion).toBe(true);
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

// The force observer is injected here to isolate actual append/flush ordering.
// Native queue/handler semantics are exercised by the force admission suite.
describe("force receipt at the native persistence boundary", () => {
  test.each(["dispatch", "flush"])("an unused force observer preserves ordinary image uncertainty at %s failure", async point => {
    const manager = await nativeManager();
    const originalFlush = manager.flush.bind(manager);
    const message = { role: "user" as const, content: "Dispatched image admission", timestamp: 1 };
    try {
      if (point === "flush") manager.flush = async () => { throw new Error("Uncertified image storage"); };
      const run = beginNativePrompt(manager, async () => {
        if (point === "dispatch") throw new Error("Uncertified image storage");
        manager.appendMessage(message);
        return { agentInvoked: true };
      }, async () => {}, { matches: value => value === message, receipt: () => [], dispatched: true },
      undefined, undefined, undefined, {
        observeUserEntry() {}, observeFlushedUserEntry() {},
        // An observer without a force command returns the original error.
        failure: error => error,
      });
      await expect(run.accepted).rejects.toMatchObject({ name: "OmpPromptAdmissionError", code: "OUTCOME_UNKNOWN" });
      await expect(run.completion).rejects.toThrow("Uncertified image storage");
    } finally { manager.flush = originalFlush; await manager.close(); }
  });

  test("publishes the flushed force entry before accepted continuations", async () => {
    const manager = await nativeManager();
    const turn = Promise.withResolvers<void>();
    const phases: string[] = [];
    let observed: string | undefined;
    let flushed: string | undefined;
    try {
      const run = beginNativePrompt(manager, async () => {
        manager.appendMessage({ role: "user", content: "Force optional prompt", timestamp: 1 });
        await turn.promise;
        return { agentInvoked: true };
      }, async () => {}, undefined, undefined, undefined, undefined, {
        observeUserEntry(id) { observed = id; phases.push("append"); },
        observeFlushedUserEntry(id) { flushed = id; phases.push("flush"); },
        failure(error) { return error; },
      });
      const accepted = await run.accepted;
      phases.push("accepted");
      expect(accepted).toEqual({ kind: "user-message", entryId: observed! });
      expect(flushed).toBe(observed);
      expect(phases).toEqual(["append", "flush", "accepted"]);
      const disk = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(disk.some(entry => entry.id === flushed && entry.message?.content === "Force optional prompt")).toBe(true);
      turn.resolve();
      expect(await run.completion).toBe(true);
    } finally { turn.resolve(); await manager.close(); }
  });

  test("failed persistence reports uncertain force admission and never a flushed entry", async () => {
    const manager = await nativeManager();
    const classifications: boolean[] = [];
    let flushed = false;
    const storage = { onEntryAppended: manager.onEntryAppended, flush: async () => { throw new Error("Force disk failure"); } };
    try {
      const run = beginNativePrompt(storage, async () => {
        const id = manager.appendMessage({ role: "user", content: "Unconfirmed force prompt", timestamp: 1 });
        storage.onEntryAppended?.(manager.getEntry(id)!);
        return { agentInvoked: true };
      }, async () => {}, undefined, undefined, undefined, undefined, {
        observeUserEntry() {},
        observeFlushedUserEntry() { flushed = true; },
        failure(error, uncertain = false) {
          classifications.push(uncertain);
          return Object.assign(new Error("Force receipt retained", { cause: error }), { code: "OUTCOME_UNKNOWN", forceToolReceipt: { commandId: "original-force", arm: "armed", prompt: "unknown" } });
        },
      });
      await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", forceToolReceipt: { commandId: "original-force", arm: "armed", prompt: "unknown" } });
      await expect(run.completion).rejects.toThrow("Force disk failure");
      expect(classifications).toContain(true);
      expect(flushed).toBe(false);
    } finally { await manager.close(); }
  });
});
