import { expect, test } from "bun:test";
import type { ComposerAction, ComposerActionsCatalog } from "@agent-desktop/shared";
import type { SessionUsage } from "../../../../packages/shared/src/session-usage";
import { nativeUsageResetWinner, usageResetAccount, usageResetArgument } from "./usage-reset-command";

const builtin: ComposerAction = { id: "builtin:usage", name: "usage", description: "Provider usage", insertText: "/usage ",
  source: { kind: "builtin", label: "Native OMP" }, availability: "executable", desktopAction: "usage-reset", argumentCompletions: true };
const catalog = (commands: ComposerAction[]): ComposerActionsCatalog => ({ protocolVersion: 1, hostId: "host", target: { sessionId: "session" },
  cwd: "/fixture", revision: "revision", commands, skills: [], diagnostics: [] });

test("only native reset spellings route to confirmation; reports, malformed verbs and leading whitespace keep native send", () => {
  for (const [input, expected] of [["/usage reset", ""], ["/usage:RESET active", "active"], ["/usage\treset Same Email", "Same Email"],
    ["/usage\nreset\tAccount One ", "Account One"], ["/usage reset:active", undefined], ["/usage show", undefined],
    ["/usage show extra", undefined], ["/usage", undefined], ["/Usage reset", undefined], [" /usage reset", undefined],
    ["/usage-other reset", undefined]] as const) expect(usageResetArgument(input)).toBe(expected);
});

test("literal extension/custom/MCP precedence is preserved before builtin separator parsing", () => {
  for (const kind of ["extension", "custom", "mcp-prompt"] as const) {
    const custom: ComposerAction = { ...builtin, id: "custom", source: { kind, label: "User command" }, desktopAction: undefined };
    const shadowed = { ...builtin, availability: "shadowed" as const };
    expect(nativeUsageResetWinner(catalog([custom, shadowed]), "/usage reset active")).toBe(false);
    expect(nativeUsageResetWinner(catalog([custom, shadowed]), "/usage:reset active")).toBe(true);
    expect(nativeUsageResetWinner(catalog([{ ...custom, name: "usage:reset" }, builtin]), "/usage:reset active")).toBe(false);
    expect(nativeUsageResetWinner(catalog([{ ...custom, name: "usage\treset" }, builtin]), "/usage\treset active")).toBe(false);
  }
  expect(() => nativeUsageResetWinner(catalog([{ ...builtin, desktopAction: undefined }]), "/usage reset")).toThrow("Update the owning host");
  expect(nativeUsageResetWinner(catalog([builtin]), "/usage show")).toBe(false);
});

const snapshot = (): SessionUsage => ({ version: 1, sessionId: "session", epoch: "epoch", revision: "revision", reports: [], reportStatus: "not-loaded",
  credits: ["second", "first"].map(accountRef => ({ accountRef, active: accountRef === "second", availableCount: 2, credits: [], canPrepare: true })),
  resetCommandAccounts: [
    { accountRef: "second", label: "Same Email", email: "Same Email", accountId: "id two", active: true, availableCount: 2 },
    { accountRef: "first", label: "Same Email", email: "Same Email", accountId: "id one", active: false, availableCount: 5 },
  ], modelSelectors: [], policy: { autoRedeem: "unset", minBlockedMinutes: 60, keepCredits: 0, salvageHorizonHours: 12 } });

test("account matching preserves native order, full remainder and exact opaque reference", () => {
  const value = snapshot(), before = JSON.stringify(value);
  expect(usageResetAccount(value, "")).toBeUndefined();
  expect(usageResetAccount(value, "ACTIVE")).toBe("second");
  expect(usageResetAccount(value, "  same EMAIL ")).toBe("second");
  expect(usageResetAccount(value, "ID ONE")).toBe("first");
  expect(() => usageResetAccount(value, "same")).toThrow("No Codex account matches");
  expect(JSON.stringify(value)).toBe(before);
});

test("legacy, empty, unavailable, zero-credit and orphan opaque rows fail visibly without selecting a substitute", () => {
  const value = snapshot();
  expect(() => usageResetAccount({ ...value, resetCommandAccounts: undefined }, "active")).toThrow("Update the owning host");
  expect(() => usageResetAccount({ ...value, resetCommandAccounts: [] }, "")).toThrow("No Codex accounts");
  expect(() => usageResetAccount({ ...value, resetCommandAccounts: value.resetCommandAccounts!.map(row => ({ ...row, active: false })) }, "active")).toThrow("No Codex account matches");
  for (const change of [{ availableCount: 0 }, { unavailable: "provider unavailable" }, { accountRef: "foreign" }]) {
    const changed = { ...value, resetCommandAccounts: [{ ...value.resetCommandAccounts![0]!, ...change }, value.resetCommandAccounts![1]!] };
    expect(() => usageResetAccount(changed, "same email")).toThrow();
  }
});
