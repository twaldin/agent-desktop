import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { WorkspaceState } from "./workspace-state";
import { GitFileHistoryState } from "./git-file-history-state";
import { WorkspaceService } from "../../../host/src/workspace/service";
import { createGitFileFixture } from "../../../../scripts/acceptance/git-file-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const repository = await createGitFileFixture(); roots.push(repository.root);
  const service = new WorkspaceService(repository.cwd), calls: { host?: string; target: unknown; query: WorkspaceQuery }[] = [];
  let gate: Promise<void> | undefined;
  const query = async (value: WorkspaceQuery): Promise<WorkspaceQueryResult> => {
    if (value.type === "git.file-inspect") return { type: value.type, inspection: await service.inspectGitFile(value.path, value.expression) };
    if (value.type === "git.file-revision") return { type: value.type, revision: await service.gitFileRevision(value.origin, value.location) };
    if (value.type === "git.file-history") return { type: value.type, history: await service.gitFileHistory(value.origin, value.start) };
    throw new Error(`Unexpected query ${value.type}`);
  };
  const bridge = { workspaceQuery: async (target, value, host) => { calls.push({ target, query: value, host }); const result = await query(value); await gate; return result; },
    command: async () => { throw new Error("History must never issue a workspace mutation"); }, subscribe: () => () => {} } as ConstructorParameters<typeof WorkspaceState>[0];
  const data = new WorkspaceState(bridge, "original-host", { projectId: "original-project" }, { read: async () => null, write: async () => {} });
  data.connected = true; data.restored = true;
  const content = await service.readText("src/renamed.ts");
  data.documents.set("src/renamed.ts", { content, text: repository.changedText, dirty: false });
  const state = new GitFileHistoryState(data, "src/renamed.ts"); state.enabled = true;
  return { ...repository, data, state, calls, hold: (value?: Promise<void>) => { gate = value; } };
}

test("immutable opening preserves a dirty native buffer, original host routing and cached offline revision identity", async () => {
  const f = await fixture(); await f.state.refresh();
  expect(f.state.workingMatches).toBe(true);
  const document = f.data.documents.get("src/renamed.ts")!;
  document.text += "// local editor only\n"; document.dirty = true;
  expect(f.state.workingMatches).toBe(false); expect(f.state.blame?.unavailable).toContain("differs");
  const before = { ...document };
  const first = f.state.commits.find(commit => commit.commit === f.first)!;
  await f.state.openRevision(first, 60);
  expect(f.state.selected?.content).toMatchObject({ kind: "text", text: f.originalText });
  expect(f.state.reveal?.line).toBe(60);
  expect(f.data.documents.get("src/renamed.ts")).toEqual(before);
  expect(f.data.documents.has("src/original.ts")).toBe(false);
  f.state.closeRevision(); f.data.connected = false;
  const callCount = f.calls.length;
  await f.state.openRevision(first);
  expect(f.state.selected?.location).toEqual({ commit: f.first, path: "src/original.ts" });
  expect(f.calls.length).toBe(callCount);
  expect(f.calls.every(call => call.host === "original-host" && JSON.stringify(call.target) === JSON.stringify({ projectId: "original-project" }))).toBe(true);
  f.state.closeRevision(); await f.state.openRevision({ commit: f.edited, path: "src/original.ts" });
  expect(f.state.selected).toBeUndefined(); expect(f.state.error).toContain("disconnected");
});

test("disposed or disconnected owner cannot publish a late file read; invalidation removes live blame eligibility", async () => {
  const f = await fixture();
  let release!: () => void; f.hold(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.state.refresh(); f.state.dispose(); release(); await pending;
  expect(f.state.inspection).toBeUndefined();
  const g = await fixture();
  let disconnectRelease!: () => void; g.hold(new Promise<void>(resolve => { disconnectRelease = resolve; }));
  const disconnected = g.state.refresh(); g.data.connected = false; disconnectRelease(); await disconnected;
  expect(g.state.inspection).toBeUndefined(); expect(g.state.error).toContain("disconnected");
  g.hold(); g.data.connected = true; await g.state.refresh(); g.data.repositoryInvalidation++;
  expect(g.state.stale).toBe(true); expect(g.state.blame?.unavailable).toContain("Repository changed");
});
