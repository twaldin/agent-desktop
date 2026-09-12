import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerRuntime } from "./runtime";

// Actual SDK/native extension runner + stdio provider in a disposable child;
// outbound provider fetch is disabled before imports. No AgentSession is made.
test("native MCP owner discovers and approves an app without creating a conversation or running a model", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-mcp-owner-"))), agentDir = path.join(root, "agent"), cwd = path.join(root, "default-directory"), log = path.join(root, "wire.jsonl");
  await Promise.all([agentDir, cwd].map(value => mkdir(value)));
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(path.join(import.meta.dir, "../omp/fixtures/mcp-app-policy.ts"))}\n  - ${JSON.stringify(path.join(import.meta.dir, "../omp/fixtures/mcp-owner-startup.ts"))}\ntools:\n  approvalMode: always-ask\nmcp:\n  enableProjectConfig: false\n`);
  await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath,
    args: [path.join(import.meta.dir, "../omp/fixtures/mcp-app-server.ts")], env: { MCP_APP_TEST_LOG: log } } } }));
  await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "/this-project-shadow-must-not-run" } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, "fixtures/no-provider-worker.ts"),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, MCP_OWNER_NOTIFICATIONS: path.join(root, "notifications.jsonl"), TERM: "dumb" } });
  try {
    const owner = await runtime.createMcpOwner({ id: "original-owner", cwd });
    expect(owner.id).toBe("original-owner"); expect(owner.cwd).toBe(cwd);
    expect((await owner.read()).available).toBe(false);
    for (let index = 0; index < 300 && !(await owner.interactions()).length; index++) await Bun.sleep(10);
    const startup = (await owner.interactions())[0]!;
    expect(startup.title).toBe("Connect directory apps?"); expect(startup.message).toContain(cwd);
    await owner.respond(startup.id, { value: true });
    let snapshot = await owner.read();
    // Native notification discovery populates these advertised resource lists asynchronously.
    for (let index = 0; index < 300 && (!snapshot.available || snapshot.servers.some(server => server.resources === null || server.resourceTemplates === null)); index++) { await Bun.sleep(10); snapshot = await owner.read(); }
    const server = snapshot.servers.find(value => value.name === "fixture")!, app = server.apps![0]!;
    expect(server.resources).not.toBeNull(); expect(server.resourceTemplates).not.toBeNull();
    expect(app.title).toBe("Counter app"); expect(snapshot.canOpenApps).toBe(true);
    const selection = { epoch: snapshot.epoch, expectedRevision: snapshot.revision, serverName: server.name, toolName: app.toolName, resourceUri: app.resourceUri };
    expect(await owner.request({ type: "open", channelId: "original-app", selection })).toMatchObject({ type: "opened" });
    await owner.request({ type: "open", channelId: "sibling-app", selection });
    for (const channelId of ["original-app", "sibling-app"]) await owner.request({ type: "request", channelId, requestId: "subscribe", method: "resources/subscribe", params: { uri: "fixture://counter" } });
    const originalEvents = owner.request({ type: "events", channelId: "original-app", after: 0 });
    const siblingEvents = owner.request({ type: "events", channelId: "sibling-app", after: 0 });
    const call = owner.request({ type: "request", channelId: "original-app", requestId: "increment", method: "tools/call", params: { name: "increment", arguments: { by: 3 } } });
    void call.catch(() => {});
    for (let index = 0; index < 300 && !(await owner.interactions()).length; index++) await Bun.sleep(10);
    const pending = await owner.interactions();
    expect(pending).toHaveLength(1); expect(pending[0]!.notificationKind).toBe("permission");
    await owner.respond(pending[0]!.id, { value: "Approve" });
    expect(await call).toMatchObject({ type: "result", value: { content: [{ text: "Extension replaced the app result" }] } });
    expect(await owner.interactions()).toHaveLength(0);
    expect(await originalEvents).toMatchObject({ type: "events", sequence: 1, uris: ["fixture://counter"] });
    expect(await siblingEvents).toMatchObject({ type: "events", sequence: 1, uris: ["fixture://counter"] });
    expect(await owner.request({ type: "request", channelId: "sibling-app", requestId: "resync", method: "resources/read", params: { uri: "fixture://counter" } })).toMatchObject({ value: { contents: [{ text: "Resource count 4" }] } });
    await owner.request({ type: "close", channelId: "original-app" });
    const beforeSiblingClose = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(beforeSiblingClose.filter(value => value.method === "resources/subscribe")).toHaveLength(1);
    expect(beforeSiblingClose.filter(value => value.method === "resources/unsubscribe")).toHaveLength(0);
    await owner.request({ type: "close", channelId: "sibling-app" });
    await owner.dispose();
    const notifications = (await readFile(path.join(root, "notifications.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(notifications.some(value => value.server === "fixture" && value.method === "notifications/resources/updated" && value.params.uri === "fixture://counter")).toBe(true);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(value => value.method === "tools/call").map(value => value.params)).toEqual([{ name: "increment", arguments: { by: 4 } }]);
    expect(requests.filter(value => value.method === "initialize")).toHaveLength(1);
    expect(requests.filter(value => value.method === "resources/unsubscribe")).toHaveLength(1);
    expect(await readdir(path.join(agentDir, "sessions")).catch(error => { if (error.code === "ENOENT") return []; throw error; })).toEqual([]);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 40_000);

test("retiring the original owner during native startup permission drains without publishing a catalogue or conversation", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-mcp-owner-startup-"))), agentDir = path.join(root, "agent"), cwd = path.join(root, "directory");
  await Promise.all([agentDir, cwd].map(value => mkdir(value)));
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(path.join(import.meta.dir, "../omp/fixtures/mcp-owner-startup.ts"))}\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, "fixtures/no-provider-worker.ts"), environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  try {
    const owner = await runtime.createMcpOwner({ id: "pending-original-owner", cwd });
    for (let index = 0; index < 300 && !(await owner.interactions()).length; index++) await Bun.sleep(10);
    const pending = (await owner.interactions())[0]!;
    expect(pending.title).toBe("Connect directory apps?"); expect((await owner.read()).available).toBe(false);
    await owner.dispose(); await owner.dispose();
    await expect(owner.respond(pending.id, { value: true })).rejects.toThrow();
    await expect(owner.read()).rejects.toThrow();
    expect(await readdir(path.join(agentDir, "sessions")).catch(error => { if (error.code === "ENOENT") return []; throw error; })).toEqual([]);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 40_000);
