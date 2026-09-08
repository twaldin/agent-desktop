import { afterEach, expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult, DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { WorkspaceQueryResult } from "../../../../packages/shared/src/workspace-protocol";
import { WorkspaceState } from "./workspace-state";
import { transcriptHostFileActions } from "./transcript-file-actions";

const states: WorkspaceState[] = [];
afterEach(() => { for (const state of states.splice(0)) state.stop(); });

function fixture(overrides: { command?: (envelope: CommandEnvelope, hostId?: string) => Promise<CommandResult>; query?: (query: unknown, hostId?: string) => Promise<WorkspaceQueryResult> } = {}) {
  const calls: { envelope?: CommandEnvelope; hostId?: string; query?: unknown; queries: unknown[] } = { queries: [] };
  const bridge = {
    workspaceQuery: async (_target: unknown, query: unknown, hostId?: string) => {
      calls.query = query; calls.queries.push(query); calls.hostId = hostId;
      return overrides.query ? overrides.query(query, hostId) : { type: "file.open-options", path: "src/name #1.ts", targets: [{ id: "editor", label: "Editor", kind: "editor" }], preferredTargetId: "editor" };
    },
    command: async (envelope: CommandEnvelope, hostId?: string) => { calls.envelope = envelope; calls.hostId = hostId; return overrides.command?.(envelope, hostId) ?? { ok: true, commandId: envelope.id, value: { type: "file.open", targetId: envelope.command.type === "workspace.mutate" && envelope.command.action.type === "file.open" ? envelope.command.action.targetId : "editor" } }; },
    subscribe: () => () => {},
  } as unknown as DesktopBridge;
  const cache = { read: async () => null, write: async () => {} };
  const data = new WorkspaceState(bridge, "owner-host", { sessionId: "owner-session" }, cache, "local-host");
  data.setConnected(true); states.push(data);
  return { data, calls };
}

test("opens through the owning WorkspaceState without a dock and preserves the owner target", async () => {
  const { data, calls } = fixture();
  await data.restore();
  const actions = transcriptHostFileActions(data);
  await actions.openFileOnHost!({ path: "src/name #1.ts" });
  expect(calls.queries.find(query => (query as { type?: string }).type === "file.open-options")).toEqual({ type: "file.open-options", path: "src/name #1.ts" });
  expect(calls.hostId).toBe("owner-host");
  expect(calls.envelope?.command).toEqual({ type: "workspace.mutate", target: { sessionId: "owner-session" }, action: { type: "file.open", path: "src/name #1.ts", targetId: "editor" } });
});

test("refuses locations, stale targets, and a reconnect race before file.open", async () => {
  const first = fixture(); await first.data.restore();
  const actions = transcriptHostFileActions(first.data);
  await expect(actions.openFileOnHost!({ path: "src/name.ts", line: 4, column: 2 })).rejects.toThrow("line location");
  expect(first.calls.queries.some(query => (query as { type?: string }).type === "file.open-options")).toBe(false);
  await expect(actions.openFileOnHost!({ path: "src/name #1.ts" }, "missing-editor")).rejects.toThrow("unavailable");
  expect(first.calls.envelope).toBeUndefined();

  const race = fixture({ query: async query => { race.data.setConnected(false); return { type: "file.open-options", path: (query as { path: string }).path, targets: [{ id: "editor", label: "Editor", kind: "editor" }], preferredTargetId: "editor" }; }});
  await race.data.restore();
  await expect(transcriptHostFileActions(race.data).openFileOnHost!({ path: "src/name #1.ts" })).rejects.toThrow("Reconnect");
  expect(race.calls.envelope).toBeUndefined();
});

test("surfaces durable command rejection and unresolved busy state", async () => {
  const rejected = fixture({ command: async envelope => ({ ok: false, commandId: envelope.id, error: { code: "COMMAND_FAILED", message: "Host refused this file" } }) });
  await rejected.data.restore();
  await expect(transcriptHostFileActions(rejected.data).openFileOnHost!({ path: "src/name #1.ts" })).rejects.toThrow("Host refused this file");
  expect(rejected.data.pending).toBeUndefined();

  const busy = fixture(); await busy.data.restore();
  busy.data.pending = { envelope: { id: "existing", command: { type: "workspace.mutate", target: { sessionId: "owner-session" }, action: { type: "file.open", path: "other.ts", targetId: "editor" } } }, uncertain: true };
  await expect(transcriptHostFileActions(busy.data).openFileOnHost!({ path: "src/name #1.ts" })).rejects.toThrow("outcome is unresolved");
  expect(busy.calls.envelope).toBeUndefined();
});

test("fails before querying when the owner host is disconnected", async () => {
  const { data, calls } = fixture(); await data.restore(); data.setConnected(false);
  await expect(transcriptHostFileActions(data).fileOpenOptions!({ path: "src/name #1.ts" })).rejects.toThrow("Reconnect");
  expect(calls.queries.some(query => (query as { type?: string }).type === "file.open-options")).toBe(false);
});

test("explicit reveal targets the file while editor actions preserve location intent", async () => {
  const {data,calls} = fixture({query:async () => ({type:"file.open-options",path:"src/name #1.ts",targets:[{id:"fileManager",label:"Finder",kind:"file-manager"}]})});
  await transcriptHostFileActions(data).openFileOnHost!({path:"src/name #1.ts",line:12,column:2},"fileManager");
  expect(calls.envelope?.command).toMatchObject({action:{type:"file.open",path:"src/name #1.ts",targetId:"fileManager"}});
});

test("rejects discovery for another path and never replays an uncertain launch", async () => {
  const mismatched = fixture({ query: async () => ({ type: "file.open-options", path: "other.ts", targets: [] }) });
  await expect(transcriptHostFileActions(mismatched.data).fileOpenOptions!({path:"src/name #1.ts"})).rejects.toThrow("different file");
  expect(mismatched.calls.envelope).toBeUndefined();
  let dispatches = 0;
  const uncertain = fixture({ command: async envelope => {
    dispatches++;
    return {ok:false,commandId:envelope.id,error:{code:"OUTCOME_UNKNOWN",message:"The application may have opened"}};
  }});
  const actions = transcriptHostFileActions(uncertain.data);
  await expect(actions.openFileOnHost!({path:"src/name #1.ts"})).rejects.toThrow("may have opened");
  const original = uncertain.data.pending?.envelope.id;
  expect(original).toBeDefined();
  await expect(actions.openFileOnHost!({path:"src/name #1.ts"})).rejects.toThrow();
  expect(uncertain.data.pending?.envelope.id).toBe(original);
  expect(dispatches).toBe(1);
});
