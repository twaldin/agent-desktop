import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NativeTerminalAttachment, NativeTerminalInfo } from "@agent-desktop/shared";
import { startHost } from "./server";
import { assertNoLiveTerminals, assertNoNativeTerminalOwnership } from "../../../scripts/terminal-upgrade-guard";

const bundle = process.env.AGENT_TEST_TMUX_BUNDLE;
const resources: { directory: string; host?: Awaited<ReturnType<typeof startHost>>; socket?: WebSocket }[] = [];
afterEach(async () => { for (const item of resources.splice(0)) { item.socket?.close(); await item.host?.stop(); await rm(item.directory, { recursive: true, force: true }); } });

describe.skipIf(!bundle)("host server with verified native terminal bundle", () => {
  test("authenticated server routes own real shell, viewer events and upgrade guard lifecycle", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-native-server-")));
    const item = { directory, host: undefined as Awaited<ReturnType<typeof startHost>> | undefined, socket: undefined as WebSocket | undefined }; resources.push(item);
    const dataDirectory = join(directory, "data"), project = join(directory, "project"), agentDirectory = join(directory, "omp");
    await mkdir(project); await mkdir(agentDirectory);
    const host = await startHost({ dataDirectory, agentDirectory, discoveryDirectory: project, nativeTerminalBundle: resolve(bundle!),
      workerPath: join(import.meta.dir, "omp-workers/fixtures/no-provider-worker.ts") }); item.host = host;
    const headers = { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" };
    const request = (path: string, body?: unknown) => fetch(host.connection.origin + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = async (path: string, body?: unknown) => { const response = await request(path, body); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store"); return response.json() as Promise<any>; };
    for (const path of ["/v2/terminals/capabilities", "/v2/terminals/query", "/v2/terminals/action", "/v2/terminals/input"]) {
      expect((await fetch(host.connection.origin + path)).status).toBe(401);
      expect((await fetch(host.connection.origin + path, { headers: { ...headers, Origin: "null" } })).status).toBe(401);
    }
    expect((await json("/v2/terminals/capabilities")).protocol).toBe("tmux-v1");
    expect((await json("/v1/terminals/query", { type: "list" })).terminals).toEqual([]);
    const invalidOwner = await request("/v2/terminals/action", { type: "create", options: { target: { projectId: crypto.randomUUID() } } });
    expect(invalidOwner.status).toBe(409);
    expect((await json("/v2/terminals/query", { type: "list" })).terminals).toEqual([]);
    const added = await host.dispatch({ id: crypto.randomUUID(), command: { type: "project.add", path: project, name: "Native server acceptance" } });
    expect(added.ok).toBe(true);
    const owner = host.store.listProjects().find(p => p.path === project)!;
    const events: any[] = [];
    const socket = new WebSocket(host.connection.origin.replace("http:", "ws:") + "/v1/events", ["agent-desktop", host.connection.token]); item.socket = socket;
    socket.addEventListener("message", message => events.push(JSON.parse(String(message.data))));
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Native server event connection failed")), { once: true }); });
    const terminal = (await json("/v2/terminals/action", { type: "create", options: { target: { projectId: owner.id }, cols: 80, rows: 24 } })).terminal as NativeTerminalInfo;
    expect(terminal.cwd).toBe(project); expect(terminal.protocol).toBe("tmux-v1"); expect(terminal.pid).toBeGreaterThan(0);
    expect(() => assertNoNativeTerminalOwnership(dataDirectory)).toThrow("native terminal");
    await expect(assertNoLiveTerminals(host.connection)).rejects.toThrow("terminal is open");
    const attachment = (await json("/v2/terminals/action", { type: "attach", terminalId: terminal.id, viewerId: crypto.randomUUID() })).attachment as NativeTerminalAttachment;
    await json("/v2/terminals/action", { type: "heartbeat", attachmentId: attachment.id, afterSequence: 0, geometryRevision: attachment.geometryRevision });
    const clientId = crypto.randomUUID(), marker = `native-server-${crypto.randomUUID()}`;
    const input = { terminalId: terminal.id, attachmentId: attachment.id, inputEpoch: attachment.inputEpoch, geometryRevision: attachment.geometryRevision, clientId };
    expect((await json("/v2/terminals/input", { ...input, sequence: 1, input: { kind: "text", data: `printf '%s\\n' '${marker}'` } })).outcome).toBe("accepted");
    expect((await json("/v2/terminals/input", { ...input, sequence: 2, input: { kind: "key", key: "Enter" } })).outcome).toBe("accepted");
    const outputReceived = () => events.some(event => event.type === "native-terminal" && event.event.type === "output" && event.event.attachmentId === attachment.id);
    const stateReceived = () => events.some(event => event.type === "native-terminal" && event.event.type === "state" && event.event.terminal.id === terminal.id);
    const deadline = Date.now() + 10_000; let found = false;
    while (Date.now() < deadline) {
      const history = (await json("/v2/terminals/query", { type: "history", terminalId: terminal.id })).history;
      if ([history.history, history.screen ?? ""].join("\n").split("\n").some((line: string) => line.trim() === marker)) found = true;
      // HTTP history and WebSocket delivery are independent observations.
      if (found && outputReceived() && stateReceived()) break;
      await Bun.sleep(50);
    }
    expect(found).toBe(true);
    expect(outputReceived()).toBe(true);
    expect(stateReceived()).toBe(true);
    await json("/v2/terminals/action", { type: "close", terminalId: terminal.id });
    const closed = (await json("/v2/terminals/query", { type: "list" })).terminals.find((entry: NativeTerminalInfo) => entry.id === terminal.id);
    expect(closed.exitedAt).toBeNumber();
    expect(() => assertNoNativeTerminalOwnership(dataDirectory)).toThrow("recorded ownership");
    expect(() => assertNoNativeTerminalOwnership(dataDirectory, { allowRetainedFinalScreens: true })).not.toThrow();
    await assertNoLiveTerminals(host.connection);
    await host.stop(); item.host = undefined;
    expect(() => assertNoNativeTerminalOwnership(dataDirectory)).not.toThrow();
  }, 30_000);
});
