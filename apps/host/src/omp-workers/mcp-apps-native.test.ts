import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerRuntime } from "./runtime";

test("real owned worker advertises Apps, projects its catalogue, and binds UI operations across reconnect", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-mcp-apps-"))), agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), log = path.join(root, "requests.jsonl");
  await Promise.all([agentDir, cwd].map(value => mkdir(value)));
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(path.join(import.meta.dir, "../omp/fixtures/mcp-app-policy.ts"))}\ntools:\n  approvalMode: always-ask\n  approval:\n    mcp__fixture_ordinary: deny\n`);
  await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath,
    args: [path.join(import.meta.dir, "../omp/fixtures/mcp-app-server.ts")], env: { MCP_APP_TEST_LOG: log } } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, "fixtures/no-provider-worker.ts"),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  try {
    const session = await runtime.create({ cwd, interactions: true });
    const approve = async (choice: "Approve" | "Deny") => {
      for (let i = 0; i < 300; i++) {
        const pending = await session.listInteractions();
        if (pending.length) { expect(pending[0]!.notificationKind).toBe("permission"); await session.respondInteraction(pending[0]!.id, { value: choice }); return; }
        await Bun.sleep(10);
      }
      throw new Error("Native app tool permission was not presented");
    };
    const approved = async <T>(request: Promise<T>) => { void request.catch(() => {}); await approve("Approve"); return request; };
    const snapshot = await session.getSessionMcp(), server = snapshot.servers.find(value => value.name === "fixture")!;
    expect(snapshot.canOpenApps).toBe(true);
    expect(server.apps?.map(app => app.title)).toEqual(["Counter app"]);
    expect(server.tools.some(name => name.endsWith("increment"))).toBe(false);
    expect(server.tools.some(name => name.endsWith("counter"))).toBe(true);
    const app = server.apps![0]!, selection = { epoch: snapshot.epoch, expectedRevision: snapshot.revision, serverName: server.name, toolName: app.toolName, resourceUri: app.resourceUri };
    expect(await session.sessionMcpApp({ type: "open", channelId: "first", selection })).toMatchObject({ type: "opened", resource: { html: "<h1>Counter app</h1>" } });
    const increment = { type: "request" as const, channelId: "first", requestId: "increment", method: "tools/call" as const, params: { name: "increment", arguments: { by: 2 } } };
    expect(await approved(session.sessionMcpApp(increment))).toMatchObject({ type: "result", value: { structuredContent: { count: 2 } } });
    expect(await session.sessionMcpApp(increment)).toMatchObject({ value: { structuredContent: { count: 2 } } });
    await expect(session.sessionMcpApp({ ...increment, params: { name: "increment", arguments: { by: 3 } } })).rejects.toThrow();
    expect(await session.sessionMcpApp({ type: "request", channelId: "first", requestId: "read", method: "resources/read", params: { uri: "fixture://notes" } })).toMatchObject({ value: { contents: [{ text: "Notes from the original MCP provider" }] } });
    const before = await session.getSessionMcp();
    await session.reconnectSessionMcp({ epoch: before.epoch, expectedRevision: before.revision, serverName: "fixture" });
    await expect(session.sessionMcpApp(increment)).rejects.toThrow("original");
    await session.sessionMcpApp({ type: "close", channelId: "first" });
    const after = await session.getSessionMcp();
    expect(after.servers[0]?.apps).toHaveLength(1);
    await session.sessionMcpApp({ type: "open", channelId: "fresh", selection: { ...selection, epoch: after.epoch, expectedRevision: after.revision } });
    expect(await approved(session.sessionMcpApp({ ...increment, channelId: "fresh", requestId: "new" }))).toMatchObject({ value: { structuredContent: { count: 2 } } });
    await expect(session.sessionMcpApp({ ...increment, channelId: "fresh", requestId: "policy-denied", params: { name: "ordinary", arguments: {} } })).rejects.toThrow("blocked by user policy");
    await expect(session.sessionMcpApp({ ...increment, channelId: "fresh", requestId: "hook-blocked", params: { name: "increment", arguments: { by: 13 } } })).rejects.toThrow("Fixture extension blocked");
    expect(await session.listInteractions()).toHaveLength(0);
    const modified = await approved(session.sessionMcpApp({ ...increment, channelId: "fresh", requestId: "hook-modified", params: { name: "increment", arguments: { by: 3 } } }));
    expect(modified).toMatchObject({ value: { content: [{ type: "text", text: "Extension replaced the app result" }] } });
    if (modified.type !== "result") throw new Error("Missing app tool result");
    expect(modified.value.structuredContent).toBeUndefined();
    const denied = session.sessionMcpApp({ ...increment, channelId: "fresh", requestId: "denied" });
    void denied.catch(() => {}); await approve("Deny"); await expect(denied).rejects.toThrow("denied");
    const cancelled = session.sessionMcpApp({ ...increment, channelId: "fresh", requestId: "cancelled" });
    void cancelled.catch(() => {});
    for (let i = 0; i < 300 && !(await session.listInteractions()).length; i++) await Bun.sleep(10);
    expect(await session.listInteractions()).toHaveLength(1);
    await session.sessionMcpApp({ type: "close", channelId: "fresh" });
    await expect(cancelled).rejects.toThrow();
    expect(await session.listInteractions()).toHaveLength(0);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(value => value.method === "tools/call" && value.params.name === "increment")).toHaveLength(3);
    expect(requests.filter(value => value.method === "tools/call" && value.params.name === "increment").map(value => value.params.arguments.by)).toEqual([2, 2, 4]);
    expect(requests.some(value => value.method === "tools/call" && value.params.name === "ordinary")).toBe(false);
    expect(requests.filter(value => value.method === "initialize")).toHaveLength(2);
    for (const init of requests.filter(value => value.method === "initialize")) expect(init.params.capabilities.extensions["io.modelcontextprotocol/ui"]).toEqual({ mimeTypes: ["text/html;profile=mcp-app"] });
    await session.dispose();
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 40_000);
