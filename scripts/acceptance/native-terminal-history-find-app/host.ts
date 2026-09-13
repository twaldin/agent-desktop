import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { WindowStateStore } from "../../../apps/desktop/src/main/window-state";
import { defaultWindowView } from "../../../apps/desktop/src/window-state";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "../../../apps/desktop/src/renderer/dock-state";

// Main supervises this real host with hub; it never starts an App or a provider prompt.
const root = resolve(process.argv[2] ?? ""), repo = resolve(import.meta.dir, "../../..");
if (!basename(root).startsWith("native-history-find-") || process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, "agent")
  || process.env.AGENT_DESKTOP_DATA_DIR !== join(root, "host") || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(root, "desktop")
  || process.env.PI_DISABLE_DOTENV !== "1" || process.env.PATH?.split(":")[0] !== join(root, "bin")
  || !existsSync(join(root, "fixture-owner.json"))) throw new Error("Prepared isolated native Find profile required.");
const owner = JSON.parse(readFileSync(join(root, "fixture-owner.json"), "utf8"));
if (owner.repo !== repo || owner.root !== root || process.env.NATIVE_FIND_HOST_ENTRY !== join(import.meta.dir, "host.ts")) throw new Error("Fixture ownership mismatch.");
const mode = process.env.NATIVE_FIND_MODE ?? "full";
if ((mode !== "full" && mode !== "capture-sequencing") || owner.mode !== mode) throw new Error("Prepared native Find mode mismatch.");
if (existsSync(join(root, "context.json"))) throw new Error("Retained fixture host restart requires a separately recorded recovery run; no implicit reseeding.");
const record = (kind: string) => appendFileSync(join(root, "guard-violations.jsonl"), JSON.stringify({ kind, pid: process.pid, at: Date.now() }) + "\n", { mode: 0o600 });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) { record("host-nonloopback-fetch"); throw new Error("Nonloopback fetch forbidden."); }
  return originalFetch(input, init);
}, { preconnect: () => { record("host-preconnect"); throw new Error("Unobserved preconnect forbidden."); } }) as typeof fetch;
const { startHost } = await import("../../../apps/host/src/server");
const host = await startHost({ dataDirectory: join(root, "host"), agentDirectory: join(root, "agent"), discoveryDirectory: join(root, "project"),
  nativeTerminalBundle: owner.bundle.directory, workerPath: join(import.meta.dir, "worker.ts"), tailscale: false, port: 0 });
const { register: registerExitCleanup } = await import("@oh-my-pi/pi-utils/postmortem");
registerExitCleanup("native-history-find-fixture-host", () => host.stop(), { exitOnly: true });
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid real host reply."); return value as Record<string, unknown>; };
const text = (value: unknown): string => { if (typeof value !== "string" || !value) throw new Error("Missing real native identity."); return value; };
const integer = (value: unknown): number => { if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Invalid real native geometry."); return value; };
const request = async (path: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(host.connection.origin + path, { method: body === undefined ? "GET" : "POST", headers: {
    Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": host.connection.hostId,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Owned native fixture request failed: ${path} (${response.status})`);
  return response.json();
};
const peerState = object(await request("/v1/peers"));
if (!Array.isArray(peerState.hosts) || peerState.hosts.length !== 0) { record("host-nonzero-discovered-peers"); await host.stop(); throw new Error("Actual discovered peers must be zero before fixture writes."); }
await writeFile(join(owner.evidence, "host-peer-preflight.json"), JSON.stringify({ status: peerState.status, discoveredPeers: peerState.hosts.length, at: Date.now() }), { flag: "wx", mode: 0o600 });
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const capture = async (terminalId: string) => {
  const value = object(object(await request("/v2/terminals/query", { type: "history", terminalId })).history);
  if (value.terminalId !== terminalId || typeof value.history !== "string" || typeof value.live !== "boolean" || typeof value.revision !== "string") throw new Error("Invalid real history capture.");
  return value;
};
const terminals: Array<{ role: string; id: string; tabId: string }> = [];
try {
  const project = host.store.addProject({ path: join(root, "project"), name: "Native history Find fixture" });
  const draft = host.store.putDraft({ id: "new-conversation", projectId: project.id, text: "", model: null }, 0);
  if (!draft.ok) throw new Error("Owned draft setup failed.");
  const tabs: DockTab[] = [];
  let dock = createDockState();
  const roles: ReadonlyArray<"saved" | "other" | "live"> = mode === "capture-sequencing" ? ["live"] : ["saved", "other", "live"];
  for (const role of roles) {
    const terminal = object(object(await request("/v2/terminals/action", { type: "create", options: { target: { projectId: project.id }, cols: 80, rows: 24 } })).terminal);
    const id = text(terminal.id);
    const attachment = object(object(await request("/v2/terminals/action", { type: "attach", terminalId: id, viewerId: crypto.randomUUID() })).attachment);
    const input = { terminalId: id, attachmentId: text(attachment.id), inputEpoch: text(attachment.inputEpoch), geometryRevision: integer(attachment.geometryRevision), clientId: crypto.randomUUID() };
    await request("/v2/terminals/action", { type: "heartbeat", attachmentId: input.attachmentId, afterSequence: 0, geometryRevision: input.geometryRevision });
    const command = `exec /bin/sh ${quote(join(import.meta.dir, "emit-history.sh"))} ${quote(root)} ${quote(role)}`;
    for (const [sequence, value] of [[1, { kind: "text", data: command }], [2, { kind: "key", key: "Enter" }]] as const) {
      const receipt = object(await request("/v2/terminals/input", { ...input, sequence, input: value }));
      appendFileSync(join(owner.evidence, "setup-inputs.jsonl"), JSON.stringify({ terminalId: id, role, sequence, input: value, receipt }) + "\n", { mode: 0o600 });
      if (receipt.outcome !== "accepted") throw new Error("Real native setup input was not accepted: " + JSON.stringify(receipt));
    }
    const deadline = Date.now() + 20_000;
    let history: Record<string, unknown>;
    for (;;) {
      history = await capture(id);
      if (typeof history.screen === "string" && history.screen.includes(`READY ${role}`) && typeof history.savedNormalScreen === "string"
        && history.savedNormalScreen.includes("NORMAL needle") && String(history.history).includes("SCROLL needle")) break;
      if (Date.now() > deadline) throw new Error(`Real native output did not reach all capture sections: ${role}`);
      await Bun.sleep(50);
    }
    await request("/v2/terminals/action", { type: "detach", attachmentId: attachment.id });
    if (role === "saved") {
      await request("/v2/terminals/action", { type: "close", terminalId: id });
      history = await capture(id);
      if (history.live !== false) throw new Error("Saved terminal did not return an actual saved native capture.");
    }
    await writeFile(join(owner.evidence, `seed-${role}-history.json`), JSON.stringify(history, null, 2), { flag: "wx", mode: 0o600 });
    const tab: DockTab = { id: "", kind: "terminal", hostId: host.connection.hostId, target: `project:${project.id}`, terminalId: id, title: `History Find — ${role}` };
    tab.id = dockTabId(tab); tabs.push(tab); dock = insertDockTab(dock, tab, "right"); terminals.push({ role, id, tabId: tab.id });
  }
  dock.rightLayout = "full";
  const windowState = new WindowStateStore(join(root, "desktop"), "primary");
  const view = windowState.saveView({ ...defaultWindowView(), route: { hostId: host.connection.hostId, sessionId: null }, expandedProjects: [`${host.connection.hostId}:${project.id}`], dock: { state: dock, tabs } });
  if (view.error) throw new Error(view.error);
  await writeFile(join(root, "context.json"), JSON.stringify({ mode, hostId: host.connection.hostId, projectId: project.id, terminals }, null, 2), { flag: "wx", mode: 0o600 });
  console.log("Native history Find host ready");
  for await (const line of createInterface({ input: process.stdin, terminal: false })) {
    if (line === "stop") { await host.stop(); process.exit(0); }
    else if (line === "refresh-live") {
      if (mode !== "full") throw new Error("Refreshing output is outside the minimal capture-sequencing diagnostic.");
      await writeFile(join(root, "refresh-live"), "emit another real output line\n");
    }
    else if (line === "snapshot") {
      const snapshots = await Promise.all(terminals.map(async item => ({ ...item, history: await capture(item.id) })));
      await writeFile(join(owner.evidence, `native-snapshot-${Date.now()}.json`), JSON.stringify({ snapshots, nativeSessions: host.store.listSessions().length, at: Date.now() }, null, 2), { flag: "wx", mode: 0o600 });
      console.log("Native history Find snapshot ready");
    } else if (line) throw new Error("Unknown fixture control; only stop, refresh-live and snapshot are allowed.");
  }
} catch (error) {
  await writeFile(join(owner.evidence, `host-failure-${Date.now()}.json`), JSON.stringify({ error: String(error), at: Date.now() }), { flag: "wx", mode: 0o600 });
  await host.stop(); throw error;
} finally { await host.stop(); }
