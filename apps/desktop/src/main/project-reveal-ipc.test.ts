import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { HostState } from "@agent-desktop/shared";
import { registerProjectRevealHandler } from "./project-reveal-ipc";
import { createProjectRevealBridge } from "./project-reveal-preload";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { if (handlers.has(channel)) throw new Error("Duplicate handler"); handlers.set(channel, listener); } };
  let trusted = true, localHost: string | undefined = "owner", endpointHost = "owner", stateHost = "owner", projectHost = "owner", removed = false, path = "/not-used", shellError = "";
  const lookups: string[] = [], opened: string[] = [];
  const state = (): HostState => ({ protocolVersion: 1, host: { id: stateHost, name: "Fixture", platform: "darwin", architecture: "arm64" }, projects: removed ? [] : [
    { id: "project", hostId: projectHost, name: "Fixture", path, createdAt: 1 },
  ], sessions: [], drafts: [], models: [], lastEventSequence: 0 });
  registerProjectRevealHandler(ipc, () => { if (!trusted) throw new Error("Untrusted sender"); }, () => localHost,
    async hostId => { lookups.push(hostId); return { hostId: endpointHost, origin: "https://fixture.invalid", token: "private-token" }; },
    async () => state(), async value => { opened.push(value); return shellError; });
  const bridge = createProjectRevealBridge((channel, ...args) => {
    const handler = handlers.get(channel); if (!handler) throw new Error("Missing reveal handler");
    return handler({} as IpcMainInvokeEvent, ...args);
  });
  return { bridge, lookups, opened, setPath(value: string) { path = value; }, shellFails() { shellError = "controlled shell failure"; },
    remote() { localHost = "other"; }, wrongEndpoint() { endpointHost = "foreign"; }, wrongState() { stateHost = "foreign"; }, wrongProjectOwner() { projectHost = "foreign"; }, remove() { removed = true; }, untrust() { trusted = false; } };
}

test("registered main handler and isolated preload reveal only a current local catalog project", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-project-reveal-")); roots.push(root);
  const f = fixture(); f.setPath(root);
  await f.bridge("project", "owner");
  expect(f.lookups).toEqual(["owner"]); expect(f.opened).toEqual([root]);
  expect((await stat(f.opened[0]!)).isDirectory()).toBe(true);
});

test("remote, missing, changed and untrusted project reveal requests never open a local path", async () => {
  for (const change of ["remote", "endpoint", "state", "project-owner", "removed", "untrusted"] as const) {
    const f = fixture();
    if (change === "remote") f.remote();
    else if (change === "endpoint") f.wrongEndpoint();
    else if (change === "state") f.wrongState();
    else if (change === "project-owner") f.wrongProjectOwner();
    else if (change === "removed") f.remove();
    else f.untrust();
    await expect(f.bridge("project", "owner")).rejects.toThrow();
    expect(f.opened).toEqual([]);
  }
});

test("invalid identities and shell failure do not open a replacement project", async () => {
  const f = fixture();
  for (const [project, host] of [["", "owner"], ["project", ""], ["project\n", "owner"], ["project", "owner\0"]])
    await expect(f.bridge(project, host)).rejects.toThrow("catalogued");
  expect(f.lookups).toEqual([]); expect(f.opened).toEqual([]);
  f.shellFails();
  await expect(f.bridge("project", "owner")).rejects.toThrow("controlled shell failure");
  expect(f.opened).toEqual(["/not-used"]);
});
