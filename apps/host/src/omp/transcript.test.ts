import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TranscriptMirror } from "./transcript";

// Deterministic production-projection contracts. These fixtures are not live OMP
// or provider acceptance evidence.
const native = (messages: unknown[]) => messages.map((message, index) => ({ id: `entry-${index}`, message }));
function messageEvent(mirror: TranscriptMirror, type: "message_start" | "message_update" | "message_end", message: unknown) { mirror.accept({ type, message } as AgentSessionEvent); }

describe("native event transcript projection contract", () => {
  test("growing content keeps its display ID through durable storage, display copies and mirror restart", () => {
    const mirror = new TranscriptMirror();
    const message = { role: "assistant", timestamp: 100, content: [{ type: "text", text: "First" }] };
    messageEvent(mirror, "message_start", message);
    const first = mirror.snapshot([], [])[0];
    expect(first).toMatchObject({ text: "First", lifecycle: "streaming" });
    message.content[0].text = "First second";
    messageEvent(mirror, "message_update", message);
    expect(mirror.snapshot([], [])[0]).toMatchObject({ id: first.id, text: "First second" });
    messageEvent(mirror, "message_end", message);
    const entries = [{ id: "native-entry-id", message }];
    const complete = mirror.snapshot([structuredClone(message)], entries);
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ id: first.id, nativeId: "native-entry-id", text: "First second", lifecycle: "complete" });
    expect(new TranscriptMirror().snapshot([message], entries)[0].id).toBe(first.id);
    expect(first.text).toBe("First");
    expect(mirror.snapshot([], [])).toEqual([]); // A later native history prune must not resurrect a completed event.
  });

  test("retains native interleaving, unknown block positions, metadata and no opaque provider payload", () => {
    const message = { role: "assistant", timestamp: 100, provider: "fixture-provider", model: "fixture-model", upstreamProvider: "upstream", upstreamModel: "upstream-model", duration: 120, completedAt: 220, stopReason: "toolUse", usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.1, opaque: "drop" }, opaque: "drop" }, content: [
      { type: "text", text: "Before", textSignature: "replay-only" },
      { type: "thinking", thinking: "Reason", thinkingSignature: "replay-only" },
      { type: "toolCall", id: "t", name: "read", arguments: { path: "a.txt" }, intent: "Read a", rawBlock: "replay-only", providerMetadata: { opaque: true } },
      { type: "text", text: "After" },
      { type: "image", data: "not-forwarded", mimeType: "image/png", providerFile: { opaque: true } },
      { type: "redactedThinking", data: "not-forwarded" }, null,
    ], providerPayload: { opaque: "provider-only" }, headers: { authorization: "fixture-secret" } };
    const [result] = new TranscriptMirror().snapshot([message], native([message]));
    expect(result.content).toEqual([
      { type: "text", text: "Before" }, { type: "thinking", thinking: "Reason" },
      { type: "toolCall", id: "t", name: "read", arguments: { path: "a.txt" }, intent: "Read a" },
      { type: "text", text: "After" }, { type: "unsupported", nativeType: "image", mimeType: "image/png" },
      { type: "unsupported", nativeType: "redactedThinking" }, { type: "unsupported", nativeType: "unknown" },
    ]);
    expect(result.text).toBe("Before\nAfter");
    expect(result.assistant).toEqual({ provider: "fixture-provider", model: "fixture-model", upstreamProvider: "upstream", upstreamModel: "upstream-model", durationMs: 120, completedAt: 220, stopReason: "toolUse", usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.1 } } });
    for (const excluded of ["fixture-secret", "replay-only", "not-forwarded", "opaque", "providerPayload", "headers"]) expect(JSON.stringify(result)).not.toContain(excluded);
  });

  test("parallel tool starts and partials retain IDs when native completion order differs", () => {
    const mirror = new TranscriptMirror();
    const assistant = { role: "assistant", timestamp: 100, content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "bash", arguments: {} }] };
    const history = native([assistant]);
    mirror.snapshot([assistant], history);
    mirror.accept({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.txt" }, intent: "Read a" });
    mirror.accept({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "echo b" } });
    mirror.accept({ type: "tool_execution_update", toolCallId: "b", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "working" }] } });
    const partial = mirror.snapshot([assistant], history);
    expect(partial.map(item => item.tool?.callId)).toEqual([undefined, "a", "b"]);
    expect(partial[1].tool).toMatchObject({ status: "running", arguments: { path: "a.txt" }, intent: "Read a" });
    expect(partial[2]).toMatchObject({ text: "working", tool: { name: "bash", status: "running" } });
    const b = { role: "toolResult", toolCallId: "b", toolName: "bash", timestamp: 150, isError: false, content: [{ type: "text", text: "done b" }] };
    mirror.accept({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: { content: b.content }, isError: false });
    messageEvent(mirror, "message_start", b); messageEvent(mirror, "message_end", b);
    const a = { role: "toolResult", toolCallId: "a", toolName: "read", timestamp: 160, isError: true, content: [{ type: "text", text: "failed a" }] };
    mirror.accept({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: a.content }, isError: true });
    messageEvent(mirror, "message_start", a); messageEvent(mirror, "message_end", a);
    const complete = mirror.snapshot([assistant, b, a], native([assistant, b, a]));
    expect(complete.map(item => item.tool?.callId)).toEqual([undefined, "b", "a"]);
    expect(complete[1]).toMatchObject({ id: partial[2].id, text: "done b", tool: { isError: false, status: "completed" } });
    expect(complete[2]).toMatchObject({ id: partial[1].id, text: "failed a", tool: { isError: true, status: "completed" } });
    expect(new TranscriptMirror().snapshot([assistant, b, a], native([assistant, b, a])).map(item => item.id)).toEqual(complete.map(item => item.id));
    expect(mirror.snapshot([], [])).toEqual([]);
  });

  test("successful empty output, failure without output, and missing outcome remain distinct", () => {
    const mirror = new TranscriptMirror();
    for (const [callId, isError] of [["empty", false], ["failure", true], ["unknown", undefined]] as const) {
      mirror.accept({ type: "tool_execution_start", toolCallId: callId, toolName: "custom", args: {} });
      mirror.accept({ type: "tool_execution_end", toolCallId: callId, toolName: "custom", result: { content: [] }, isError });
    }
    const results = mirror.snapshot([], []);
    expect(results.map(result => result.text)).toEqual(["", "", ""]);
    expect(results.map(result => result.tool?.isError)).toEqual([false, true, undefined]);
    expect(results.every(result => result.lifecycle === "complete" && result.tool?.status === "completed")).toBe(true);
    expect(results.every(result => result.timestamp === undefined)).toBe(true); // No invented tool timestamp.
  });

  test("native error and abort metadata survive an empty response", () => {
    for (const stopReason of ["error", "aborted"] as const) {
      const message = { role: "assistant", timestamp: 100, content: [], stopReason, errorMessage: `Native ${stopReason}` };
      const [result] = new TranscriptMirror().snapshot([message], native([message]));
      expect(result).toMatchObject({ lifecycle: "complete", text: "", assistant: { stopReason, errorMessage: `Native ${stopReason}` } });
    }
  });

  test("equal timestamps stay distinct and a further streamed occurrence keeps its native entry", () => {
    const mirror = new TranscriptMirror();
    const a = { role: "user", timestamp: 100, content: "one" }, b = { role: "user", timestamp: 100, content: "two" }, c = { role: "user", timestamp: 100, content: "three" };
    const initial = mirror.snapshot([structuredClone(a), structuredClone(b)], native([a, b]));
    expect(new Set(initial.map(message => message.id)).size).toBe(2);
    expect(initial.map(message => message.nativeId)).toEqual(["entry-0", "entry-1"]);
    messageEvent(mirror, "message_start", c); const live = mirror.snapshot([a, b], native([a, b]));
    messageEvent(mirror, "message_end", c);
    const complete = mirror.snapshot([a, b, { ...c, content: "display copy" }], native([a, b, c]));
    expect(complete.map(message => message.id)).toEqual(live.map(message => message.id));
    expect(complete[2]).toMatchObject({ text: "display copy", nativeId: "entry-2" });
  });

  test("reused native tool ID after durable completion reserves a new display occurrence", () => {
    const mirror = new TranscriptMirror();
    const a = { role: "toolResult", timestamp: 100, toolCallId: "reused", toolName: "read", isError: false, content: "first" };
    const initial = mirror.snapshot([a], native([a]));
    mirror.accept({ type: "tool_execution_start", toolCallId: "reused", toolName: "read", args: {} });
    const live = mirror.snapshot([a], native([a]));
    expect(live).toHaveLength(2);
    expect(live[0].id).not.toBe(live[1].id);
    const b = { ...a, timestamp: 200, content: "second" };
    mirror.accept({ type: "tool_execution_end", toolCallId: "reused", toolName: "read", result: { content: [{ type: "text", text: "second" }] }, isError: false });
    messageEvent(mirror, "message_start", b); messageEvent(mirror, "message_end", b);
    const complete = mirror.snapshot([a, b], native([a, b]));
    expect(complete.map(item => item.id)).toEqual([initial[0].id, live[1].id]);
    expect(complete.map(item => item.text)).toEqual(["first", "second"]);
  });

  test("display-only messages and missing tool lifecycle do not invent completion", () => {
    const messages = [{ role: "extensionNotice", customType: "fixture", content: "Native notice" }, { role: "toolResult", toolCallId: "missing", content: [] }];
    const result = new TranscriptMirror().snapshot(messages, []);
    expect(result[0]).toMatchObject({ role: "extensionNotice", text: "Native notice" });
    expect(result[0].lifecycle).toBeUndefined();
    expect(result[1].tool).toEqual({ callId: "missing" });
  });

  test("a real native file reopened before UI read seeds a reused call ID and preserves native identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-desktop-transcript-native-"));
    let manager = SessionManager.create(directory, path.join(directory, "sessions"));
    const tool = (timestamp: number, text: string) => ({ role: "toolResult" as const, toolCallId: "reused", toolName: "read", timestamp, isError: false, content: [{ type: "text" as const, text }] });
    const assistant = (timestamp: number) => ({ role: "assistant", timestamp, api: "openai-responses", provider: "fixture-provider", model: "fixture-model", content: [{ type: "toolCall", id: "reused", name: "read", arguments: {} }], stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as Parameters<SessionManager["appendMessage"]>[0];
    const snapshot = (mirror: TranscriptMirror) => mirror.snapshot(manager.buildSessionContext({ transcript: true, collapseCompactedHistory: false, keepDanglingToolCalls: true }).messages, manager.getBranch().filter(entry => entry.type === "message"));
    try {
      await manager.ensureOnDisk();
      manager.appendMessage({ role: "user", timestamp: 1, content: "Native fixture" });
      manager.appendMessage(assistant(2));
      const firstNativeId = manager.appendMessage(tool(3, "first"));
      await manager.flush();
      const file = manager.getSessionFile()!; await manager.close();
      manager = await SessionManager.open(file);
      const mirror = new TranscriptMirror();
      const resumed = snapshot(mirror); // The runtime now does this before subscription.
      expect(resumed.find(item => item.tool)?.nativeId).toBe(firstNativeId);
      manager.appendMessage(assistant(4));
      mirror.accept({ type: "tool_execution_start", toolCallId: "reused", toolName: "read", args: {} });
      const live = snapshot(mirror), pending = live.filter(item => item.tool).at(-1)!;
      expect(pending.tool?.status).toBe("running");
      const second = tool(5, "second");
      messageEvent(mirror, "message_start", second); messageEvent(mirror, "message_end", second);
      const secondNativeId = manager.appendMessage(second); await manager.flush();
      const complete = snapshot(mirror), results = complete.filter(item => item.tool);
      expect(results.map(item => item.nativeId)).toEqual([firstNativeId, secondNativeId]);
      expect(results[1].id).toBe(pending.id);
      expect(new Set(results.map(item => item.id)).size).toBe(2);
      await manager.close(); manager = await SessionManager.open(file);
      expect(snapshot(new TranscriptMirror()).map(item => item.id)).toEqual(complete.map(item => item.id));
    } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
