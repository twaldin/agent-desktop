import { expect, test } from "bun:test";
import { parseCommandEnvelope } from "./validation";

const request = {
  id: "owned-edit", commandVersion: 11,
  command: { type: "preferences.keymap.mutate", mutation: { expectedRevision: null,
    edit: { type: "command", commandId: "newTask", update: { type: "set", accelerator: "cmd+alt+n" } } } },
} as const;

test("v11 preserves the explicit expected revision and normalizes the requested operation", () => {
  expect(parseCommandEnvelope(request, 11)).toEqual({ ...request, command: { ...request.command,
    mutation: { ...request.command.mutation, edit: { ...request.command.mutation.edit, update: { type: "set", accelerator: "Command+Alt+N" } } },
  } });
  const { commandVersion: _, ...withoutVersion } = request;
  expect(parseCommandEnvelope(withoutVersion, 11).command).toEqual(parseCommandEnvelope(request, 11).command);
  for (const version of [1, 4, 9, 10] as const) expect(() => parseCommandEnvelope(withoutVersion, version)).toThrow("version 11");
  expect(() => parseCommandEnvelope({ ...request, commandVersion: 10 }, 11)).toThrow("version 11");
});

test("malformed shortcut edits cannot supply their own registry, erase revisions, or enter the v1 generic preference path", () => {
  for (const command of [
    { ...request.command, definitions: [] },
    { ...request.command, mutation: { edit: { type: "reset-all" } } },
    { ...request.command, mutation: { expectedRevision: null, edit: { type: "reset-all", commandId: "newTask" } } },
    { ...request.command, mutation: { ...request.command.mutation, edit: { ...request.command.mutation.edit, update: { type: "clear", accelerator: "Command+Q" } } } },
    { type: "preferences.put", change: { key: "general.commandKeymap", deleted: true } },
  ]) expect(() => parseCommandEnvelope({ ...request, command }, 11)).toThrow();
});
