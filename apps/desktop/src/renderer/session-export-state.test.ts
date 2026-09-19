import { expect, test } from "bun:test";
import type { CommandEnvelope, DesktopBridge } from "@agent-desktop/shared";
import { SessionExportState } from "./session-export-state";
test("lost ACK persists original request; restart inspects it without exporting again", async () => {
  const saved = new Map<string, string>(), sent: CommandEnvelope[] = [], inspected: string[] = [];
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const bridge = { command: async (e: CommandEnvelope) => { sent.push(e); throw new Error("lost response"); }, getSessionExport: async (sessionId: string, commandId: string, hostId: string) => { inspected.push(commandId); return { sessionId, commandId, hostId, state: "unknown" }; } } as unknown as DesktopBridge;
  const first = new SessionExportState(bridge, "owner", "session", storage); await first.run("web");
  expect(first.status?.state).toBe("unknown");
  const second = new SessionExportState(bridge, "owner", "session", storage); await second.inspect(); await second.run("user");
  expect(inspected).toEqual([sent[0]!.id]); expect(sent).toHaveLength(1);
});
test("explicit retry of an absent request keeps original command and theme", async () => {
  let saved: string | null = null; const sent: CommandEnvelope[] = [];
  const bridge = { command: async (e: CommandEnvelope) => { sent.push(e); throw new Error("disconnected"); }, getSessionExport: async (sessionId: string, commandId: string, hostId: string) => ({ sessionId, commandId, hostId, state: "absent" }) } as unknown as DesktopBridge;
  const data = new SessionExportState(bridge, "host", "session", { getItem: () => saved, setItem: (_k, v) => { saved = v; } });
  await data.run("web"); await data.inspect(); await data.run("user"); expect(sent[1]).toEqual(sent[0]);
});
test("local persistence failure prevents export dispatch and remains actionable", async () => {
  let calls = 0;
  const bridge = { command: async () => { calls++; } } as unknown as DesktopBridge;
  const data = new SessionExportState(bridge, "host", "session", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
  await data.run("web"); expect(calls).toBe(0); expect(data.error).toContain("Nothing was exported");
});
