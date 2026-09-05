import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, TerminalActionResult, TerminalQueryResult } from "@agent-desktop/shared";
import { startHost } from "./server";
import { assertNoRunningWork, serviceLayout } from "../../../scripts/install-host";

test("real host terminal HTTP and ephemeral events survive client detachment without duplicating input", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-terminal-transport-"));
  const agentDirectory = join(root, "native"); await mkdir(agentDirectory);
  const host = await startHost({ dataDirectory: join(root, "data"), agentDirectory, discoveryDirectory: root });
  const sockets: WebSocket[] = [];
  const headers = { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" };
  const post = (path: string, body: unknown) => fetch(host.connection.origin + path, { method: "POST", headers, body: JSON.stringify(body) });
  const events: Array<{ type: string; event?: { type: string; terminalId?: string } }> = [];
  function connect() {
    const socket = new WebSocket(host.connection.origin.replace("http", "ws") + "/v1/events", ["agent-desktop", host.connection.token]);
    sockets.push(socket);
    socket.addEventListener("message", message => events.push(JSON.parse(String(message.data))));
    return socket;
  }
  async function until(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 10_000;
    while (!await check()) { if (Date.now() > deadline) throw new Error("Terminal transport condition did not settle."); await Bun.sleep(25); }
  }
  try {
    const projectResult = await host.dispatch({ id: crypto.randomUUID(), command: { type: "project.add", path: root } });
    if (!projectResult.ok) throw new Error(projectResult.error.message);
    const project = projectResult.value as Project;
    const socket = connect(); await until(() => socket.readyState === WebSocket.OPEN);
    expect((await fetch(host.connection.origin + "/v1/terminals/query", { method: "POST", body: JSON.stringify({ type: "list" }) })).status).toBe(401);
    const created = await (await post("/v1/terminals/action", { type: "create", options: { target: { projectId: project.id }, cols: 100, rows: 30 } })).json() as TerminalActionResult;
    expect(created.terminal?.cwd).toBe(await realpath(root));
    const terminalId = created.terminal!.id;
    const layout = serviceLayout({ homeDirectory: root, dataDirectory: join(root, "data") });
    await expect(assertNoRunningWork(layout)).rejects.toThrow("terminal is open");
    const input = { terminalId, clientId: crypto.randomUUID(), sequence: 1, data: "printf '\\nTRANSPORT_%s\\n' VERIFIED\n" };
    const responses = await Promise.all([post("/v1/terminals/input", input), post("/v1/terminals/input", input)]);
    const receipts = await Promise.all(responses.map(response => response.json())) as { duplicate: boolean }[];
    expect(receipts.map(receipt => receipt.duplicate).sort()).toEqual([false, true]);
    async function replay() {
      const result = await (await post("/v1/terminals/query", { type: "replay", terminalId })).json() as TerminalQueryResult;
      if (result.type !== "replay") throw new Error("Missing native terminal replay.");
      return result.replay;
    }
    await until(async () => (await replay()).chunks.map(chunk => chunk.data).join("").includes("TRANSPORT_VERIFIED"));
    await until(() => events.some(event => event.type === "terminal" && event.event?.type === "output" && event.event.terminalId === terminalId));
    const first = await replay();
    expect(first.chunks.map(chunk => chunk.data).join("").split("TRANSPORT_VERIFIED").length - 1).toBe(1);
    socket.close(); await until(() => socket.readyState === WebSocket.CLOSED);
    await post("/v1/terminals/input", { ...input, sequence: 2, data: "printf '\\nDETACHED_%s\\n' VERIFIED\n" });
    await until(async () => (await replay()).chunks.map(chunk => chunk.data).join("").includes("DETACHED_VERIFIED"));
    const reconnected = connect(); await until(() => reconnected.readyState === WebSocket.OPEN);
    const resumed = await replay();
    expect(resumed.terminal.pid).toBe(first.terminal.pid);
    expect(resumed.lastSequence).toBeGreaterThan(first.lastSequence);
    expect(host.store.eventsAfter(0, 500).some(event => (event as { type: string }).type === "terminal")).toBe(false);
    expect(JSON.stringify(host.store.eventsAfter(0, 500))).not.toContain(input.data);
    const closed = await post("/v1/terminals/action", { type: "close", terminalId }); expect(closed.status).toBe(200);
    await assertNoRunningWork(layout);
  } finally {
    for (const socket of sockets) socket.close();
    await host.stop(); await rm(root, { recursive: true, force: true });
  }
}, 20_000);
