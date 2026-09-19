import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { exportNativeSession, nativeExportIntent } from "./session-export";
test("native extension and custom commands shadow export, including exact namespace/newline parsing", () => {
  const session = { extensionRunner: { getCommand: () => undefined }, customCommands: [] } as unknown as AgentSession;
  expect(nativeExportIntent(session, "/export")).toEqual({ theme: "web" });
  expect(nativeExportIntent(session, "/export --themes")).toEqual({ theme: "user" });
  expect(nativeExportIntent(session, " /export")).toBeNull();
  (session as any).extensionRunner.getCommand = (name: string) => name === "export" ? {} : undefined;
  expect(nativeExportIntent(session, "/export")).toBeNull();
  (session as any).extensionRunner.getCommand = () => undefined;
  (session as any).customCommands = [{ command: { name: "export" } }];
  expect(nativeExportIntent(session, "/export --themes")).toBeNull();
});
test("empty and in-memory native sessions refuse before allocating any destination", async () => {
  let writes = 0;
  const session = { sessionId: "source", sessionFile: undefined, messages: [], sessionManager: { getCwd: () => "/project" }, exportToHtml: async () => { writes++; } } as unknown as AgentSession;
  const input = { sessionId: "source", sessionFile: "/source.jsonl", cwd: "/project", outputPath: "/must-not-be-created.html", theme: "web" as const };
  await expect(exportNativeSession(session, input, () => {})).rejects.toThrow("original saved native session");
  (session as any).sessionFile = input.sessionFile;
  await expect(exportNativeSession(session, input, () => {})).rejects.toThrow("no messages");
  expect(writes).toBe(0);
});
