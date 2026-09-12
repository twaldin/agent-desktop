import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePreferenceChange } from "../../../packages/shared/src/preferences";
import type { CommandEnvelope } from "@agent-desktop/shared";
import { commandEndpoint, requestVersionedCommand } from "../../desktop/src/main/command-endpoints";
import { HostRequestError } from "../../desktop/src/main/host-transport";
import { parseCommandEnvelope } from "./validation";
import { HostStore } from "./store";
import { PreferencesStore } from "./preferences/store";

const envelope: CommandEnvelope = { id: "follow", commandVersion: 13, command: { type: "session.follow-up", sessionId: "session", text: "captured",
  delivery: "follow-up", approvalMode: "write", draft: { id: "session:session", revision: 4 } } };

test("follow-up command is explicit, bounded, draft-backed and v13-only", () => {
  expect(parseCommandEnvelope(envelope)).toEqual(envelope);
  expect(commandEndpoint(envelope)).toBe("/v13/commands");
  for (const command of [
    { ...envelope.command, delivery: undefined }, { ...envelope.command, delivery: "queue" },
    { ...envelope.command, draft: undefined }, { ...envelope.command, text: "x".repeat(4_000_001) },
    { ...envelope.command, attachments: [] },
  ]) expect(() => parseCommandEnvelope({ ...envelope, command })).toThrow();
  expect(() => parseCommandEnvelope({ ...envelope, commandVersion: "13" })).toThrow();
});

test("missing v13 is a definite unsupported receipt while uncertain delivery never falls back", async () => {
  const calls: string[] = [];
  expect(await requestVersionedCommand(async path => { calls.push(path); throw new HostRequestError("missing", 404); }, envelope))
    .toMatchObject({ ok: false, commandId: "follow", error: { code: "FOLLOW_UP_PROTOCOL_UNSUPPORTED" } });
  expect(calls).toEqual(["/v13/commands"]);
  const lost = new Error("response lost");
  await expect(requestVersionedCommand(async () => { throw lost; }, envelope)).rejects.toBe(lost);
});

test("shared preference admits only Queue and Steer values", () => {
  expect(parsePreferenceChange({ key: "general.followUpQueueMode", value: "queue" })).toEqual({ key: "general.followUpQueueMode", value: "queue" });
  expect(parsePreferenceChange({ key: "general.followUpQueueMode", value: "steer" })).toEqual({ key: "general.followUpQueueMode", value: "steer" });
  expect(() => parsePreferenceChange({ key: "general.followUpQueueMode", value: "followUp" })).toThrow();
});

test("Queue or Steer preference persists and reopens through the shared preference owner", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-desktop-follow-up-preference-"));
  try {
    const firstHost = new HostStore(root), first = new PreferencesStore(firstHost);
    expect(first.get("general.followUpQueueMode")).toBeUndefined();
    first.put({ key: "general.followUpQueueMode", value: "queue" }); firstHost.close();
    const secondHost = new HostStore(root), second = new PreferencesStore(secondHost);
    expect(second.get("general.followUpQueueMode")).toMatchObject({ deleted: false, value: "queue" });
    second.put({ key: "general.followUpQueueMode", value: "steer" });
    expect(second.get("general.followUpQueueMode")).toMatchObject({ value: "steer" });
    secondHost.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
