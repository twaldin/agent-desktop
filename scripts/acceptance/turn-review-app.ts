import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm, readdir, lstat, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createTurnReviewProject, TURN_FIXTURE_MODEL, waitForTurnFixture } from "./turn-review-native";
import { createDockState, dockTabId, insertDockTab } from "../../apps/desktop/src/renderer/dock-state";
import { defaultWindowView } from "../../apps/desktop/src/window-state";
import { WindowStateStore } from "../../apps/desktop/src/main/window-state";
import { TURN_REVIEW_OWNER_HEADER, type TurnReview } from "../../packages/shared/src/turn-review";
const repo = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2]!), wrapper = resolve(process.argv[3]!);
await mkdir(output, { recursive: true, mode: 0o700 });
const f = await createTurnReviewProject();
const isolated = { ...f.environment, AGENT_DESKTOP_DATA_DIR: join(f.root, "data"), AGENT_DESKTOP_PROFILE_DIR: join(f.root, "profile"), AGENT_DESKTOP_NATIVE_TERMINALS: "0", AGENT_DESKTOP_BUN: process.execPath, AGENT_DESKTOP_PROJECT_ROOT: repo };
Object.assign(process.env, isolated);
const { startHost } = await import("../../apps/host/src/server");
const host = await startHost({ dataDirectory: isolated.AGENT_DESKTOP_DATA_DIR, agentDirectory: f.agentDir, discoveryDirectory: f.cwd, workerPath: join(repo, "apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), tailscale: false, port: 0 });
const command = async (value: unknown) => {
  const response = await fetch(host.connection.origin + "/v2/commands", { method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": host.connection.hostId }, body: JSON.stringify({ id: crypto.randomUUID(), command: value }) });
  const result = await response.json() as { ok: boolean; value: any }; if (!response.ok || !result.ok) throw new Error(`Fixture setup failed: ${JSON.stringify(result)}`); return result.value;
};
try {
const project = await command({ type: "project.add", path: f.cwd });
const session = await command({ type: "session.create", projectId: project.id, cwd: f.cwd, model: TURN_FIXTURE_MODEL, approvalMode: "yolo" });
const readReview = async () => {
  const response = await fetch(host.connection.origin + `/v1/sessions/${session.id}/turn-review`, { headers: { Authorization: `Bearer ${host.connection.token}`, [TURN_REVIEW_OWNER_HEADER]: host.connection.hostId } });
  if (!response.ok) throw new Error(`Review status ${response.status}: ${await response.text()}`);
  return (await response.json() as { value: TurnReview }).value;
};
await command({ type: "session.prompt", sessionId: session.id, text: "turn-first: actual native dirty edit write and shell for candidate App", model: TURN_FIXTURE_MODEL, approvalMode: "yolo" });
await waitForTurnFixture(async () => {
  try { return (await readReview()).state === "available"; }
  catch (error) {
    if (!String(error).includes("original recorded review branch changed during the read")) throw error;
    await writeFile(join(output, "setup-read-retired.txt"), String(error));
    return false;
  }
}, "recorded App fixture");
const first = await readReview(); assert.equal(first.files.length, 3); assert(first.patch.includes("-DIRTY BEFORE"));
await writeFile(join(f.cwd, "tracked.txt"), "LATER DISK MUST NOT APPEAR IN RECORDED REVIEW\n");
assert.equal((await readReview()).patch, first.patch);
const descriptor = { kind: "review" as const, hostId: host.connection.hostId, target: `session:${session.id}` as const, title: "Review" }, tab = { ...descriptor, id: dockTabId(descriptor) };
const dock = insertDockTab(createDockState(), tab, "right"); dock.rightLayout = "full";
const saved = new WindowStateStore(isolated.AGENT_DESKTOP_PROFILE_DIR, "primary").saveView({ ...defaultWindowView(), route: { hostId: host.connection.hostId, sessionId: session.id }, dock: { state: dock, tabs: [tab] } });
if (saved.error) throw new Error(saved.error);
const snapshot = async () => {
  const files: Array<[string, string, number]> = [];
  const scan = async (directory: string, prefix: string) => { for (const name of (await readdir(directory)).sort()) { const path = join(directory, name), info = await lstat(path), relative = prefix + name; if (info.isDirectory()) await scan(path, relative + "/"); else files.push([relative, info.isSymbolicLink() ? await readlink(path) : createHash("sha256").update(await readFile(path)).digest("hex"), info.mode]); } };
  await scan(f.cwd, "project/"); return files;
};
const before = await snapshot();
await writeFile(join(output, "fixture.json"), JSON.stringify({ root: f.root, cwd: f.cwd, sessionId: session.id, sessionFile: session.sessionFile, hostId: host.connection.hostId, projectId: project.id, first }, null, 2));
await writeFile(join(output, "repository-before.json"), JSON.stringify(before, null, 2));
const electron = Bun.spawn([join(repo, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), wrapper, output, repo], { cwd: repo, env: isolated, stdin: "pipe", stdout: "inherit", stderr: "inherit" });
let finishing = false;
async function finish(passed: boolean) {
  if (finishing) return; finishing = true;
  const after = await snapshot(), finalReview = await readReview();
  // Existing App services may add unreachable Git objects while reading workspace
  // state. Retain the full map; user files, refs, index and existing objects must
  // remain byte/mode identical. No object modification or deletion is allowed.
  const addedObjects = after.filter(row => !before.some(old => old[0] === row[0]) && row[0].startsWith("project/.git/objects/"));
  const unchanged = JSON.stringify(before) === JSON.stringify(after.filter(row => !addedObjects.includes(row)));
  await writeFile(join(output, "repository-after.json"), JSON.stringify(after, null, 2));
  const recordedUnchanged = finalReview.patch === first.patch;
  await writeFile(join(output, "native-session.jsonl"), await readFile(session.sessionFile));
  await writeFile(join(output, "producer.jsonl"), await readFile(f.producerLog));
  if (electron.exitCode === null) { electron.stdin.write(JSON.stringify({ action: "exit" }) + "\n"); await electron.exited; }
  await host.stop();
  const success = passed && unchanged && recordedUnchanged;
  await writeFile(join(output, "runner-result.json"), JSON.stringify({ passed: success, filesRefsIndexAndExistingObjectsUnchanged: unchanged, addedGitObjects: addedObjects, recordedUnchanged, ownedElectronExited: electron.exitCode, hostStopped: true, fixtureRemoved: success, scope: "Actual production main/preload/App/Pierre plus actual native tools with local controlled provider; no official reference UI/auth/retained profile." }, null, 2));
  if (success) await rm(f.root, { recursive: true });
  console.log("TURN_APP_FINISHED", JSON.stringify({ passed: success, fixtureRemoved: success })); process.exit(success ? 0 : 1);
}
process.on("SIGTERM", () => { void finish(false); });
for await (const line of createInterface({ input: process.stdin })) {
  try { const value = JSON.parse(line); if (value.action === "finish") { await finish(value.passed === true); break; } else electron.stdin.write(JSON.stringify(value) + "\n"); }
  catch (error) { console.error("TURN_RUNNER_COMMAND_FAILED", String(error)); }
}
} catch (error) {
  await host.stop();
  await writeFile(join(output, "setup-failure.json"), JSON.stringify({ error: String(error), root: f.root, hostStopped: true, fixtureRetained: true }, null, 2));
  throw error;
}
