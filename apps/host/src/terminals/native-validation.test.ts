import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTmuxBundle } from "./bundle";
import { parseNativeTerminalAction, parseNativeTerminalInput } from "./native-http";
import { nativeInputCommand } from "./native-input";
import { NativeTerminalStore } from "./native-store";

test("native input cannot smuggle a command, cwd, generic reply or malformed byte encoding", () => {
  const request = { terminalId: crypto.randomUUID(), attachmentId: crypto.randomUUID(), inputEpoch: crypto.randomUUID(), geometryRevision: 1, clientId: crypto.randomUUID(), sequence: 1, input: { kind: "text", data: "safe" } };
  for (const input of [{ kind: "constructor" }, { kind: "key", key: "Enter ; kill-server" }, { kind: "bytes", base64: "AP8" }, { kind: "text", data: "safe", command: "kill-server" }]) expect(() => parseNativeTerminalInput({ ...request, input })).toThrow();
  expect(() => parseNativeTerminalAction({ type: "create", options: { target: { projectId: crypto.randomUUID() }, cwd: "/" } })).toThrow();
  expect(() => parseNativeTerminalAction({ type: "reply", attachmentId: crypto.randomUUID(), outputSequence: 1, ordinal: 1, data: "reply", command: "kill-server" })).toThrow();
  const command = nativeInputCommand("%0", 80, 24, { kind: "text", data: "'; kill-server; $(touch injected)\n" });
  expect(command).not.toContain("kill-server"); expect(command).not.toContain("touch injected");
  expect(nativeInputCommand("%0", 80, 24, { kind: "key", key: "C-\\" })).toContain("'C-\\'");
});

test("durable native ownership refuses symlinked metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-native-catalog-validation-"));
  try { const store = new NativeTerminalStore(join(directory, "private")); writeFileSync(join(directory, "foreign.json"), "{}"); symlinkSync(join(directory, "foreign.json"), store.catalogPath); expect(() => store.read()).toThrow("private regular file"); }
  finally { rmSync(directory, { recursive: true }); }
});

describe.skipIf(!process.env.AGENT_TEST_TMUX_BUNDLE)("actual immutable native bundle validation", () => {
  test("foreign platform verification is static; changed bytes and symlinks are rejected", () => {
    const source = process.env.AGENT_TEST_TMUX_BUNDLE!, verified = verifyTmuxBundle(source);
    expect(verifyTmuxBundle(source, verified.manifest.platform).digest).toBe(verified.digest);
    const directory = mkdtempSync(join(tmpdir(), "agent-native-bundle-validation-"));
    try {
      const copy = join(directory, "bundle"); cpSync(source, copy, { recursive: true });
      const license = join(copy, "licenses/tmux.txt"); const original = readFileSync(license); writeFileSync(license, "changed bytes"); expect(() => verifyTmuxBundle(copy)).toThrow("verification");
      writeFileSync(license, original); unlinkSync(license); symlinkSync(join(source, "licenses/tmux.txt"), license); expect(() => verifyTmuxBundle(copy)).toThrow("verification");
    } finally { rmSync(directory, { recursive: true }); }
  });
});
