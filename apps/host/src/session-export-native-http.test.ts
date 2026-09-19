import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHost } from "./server";
import type { CommandEnvelope, CommandResult, SessionSummary } from "@agent-desktop/shared";
import { saveSessionExport } from "../../desktop/src/main/session-export";
/** Actual host claim/tail, native worker/exporter, authenticated download and local save.
 * Only the native session seed and dialog selection are controlled. No provider calls. */
test("HTTP /export shares native owner service, journal replay, /dump guidance and authenticated Save as", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "export-native-http-"))), agentDirectory = join(root, "agent"), cwd = join(root, "project"), sessions = join(root, "sessions"), dataDirectory = join(root, "data");
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    await Promise.all([agentDirectory, cwd, sessions].map(path => mkdir(path)));
    await writeFile(join(agentDirectory, "config.yml"), "extensions: []\n");
    const seed = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      globalThis.fetch=Object.assign(async()=>{throw Error('Export seed outbound disabled');},{preconnect(){}});
      const {SessionManager}=await import(${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent"))});
      const manager=SessionManager.create(${JSON.stringify(cwd)},${JSON.stringify(sessions)});
      manager.appendMessage({role:'user',content:'Original HTTP export history',timestamp:1});
      await manager.ensureOnDisk();await manager.flush();console.log(JSON.stringify({id:manager.getSessionId(),file:manager.getSessionFile()}));await manager.close();
    `], { cwd, env: { HOME: root, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDirectory, TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(seed.stdout).text(), new Response(seed.stderr).text(), seed.exited]); if (code) throw new Error(err);
    const original = JSON.parse(out) as { id: string; file: string }, before = await readFile(original.file);
    const workerPath = join(root, "worker.ts");
    await writeFile(workerPath, `process.env.HOME=${JSON.stringify(root)};process.env.PI_CODING_AGENT_DIR=${JSON.stringify(agentDirectory)};globalThis.fetch=Object.assign(async()=>{throw Error('Native export HTTP outbound disabled');},{preconnect(){}});await import(${JSON.stringify(new URL("./omp-workers/entry.ts", import.meta.url).href)});`);
    const options = { dataDirectory, agentDirectory, discoveryDirectory: cwd, workerPath, port: 0, tailscale: false };
    host = await startHost(options);
    const source: SessionSummary = { id: original.id, hostId: host.store.host.id, projectId: null, cwd, sessionFile: original.file, title: "Original", model: null, status: "idle", createdAt: 1, updatedAt: 1, archived: false };
    host.store.upsertSession(source);
    const submit = async (envelope: CommandEnvelope): Promise<CommandResult> => {
      const response = await fetch(`${host!.connection.origin}/v20/commands`, { method: "POST", headers: { Authorization: `Bearer ${host!.connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
      expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
    };
    const command: CommandEnvelope = { id: "native-export", commandVersion: 20, command: { type: "session.prompt", sessionId: original.id, text: "/export --themes" } };
    const [first, duplicate] = await Promise.all([submit(command), submit(command)]); expect(duplicate).toEqual(first);
    if (!first.ok || !first.value || !("type" in first.value) || first.value.type !== "session.export") throw new Error(JSON.stringify(first));
    const receipt = first.value, destination = join(root, "download.html");
    expect(receipt.theme).toBe("user"); expect(first.admission?.kind).toBe("native-command");
    await saveSessionExport(receipt, { endpoint: async () => ({ origin: host!.connection.origin, token: host!.connection.token, hostId: source.hostId }), choose: async () => destination, current() {} });
    expect(await readFile(destination, "utf8")).toContain('<script id="session-data"'); expect(await readFile(original.file)).toEqual(before);
    expect(await submit({ id: "copy-guidance", commandVersion: 20, command: { type: "session.prompt", sessionId: source.id, text: "/export --copy" } })).toMatchObject({ ok: false, error: { code: "EXPORT_GUIDANCE", message: "Use /dump to copy the session to clipboard." } });
    await host.stop(); host = await startHost(options);
    expect(await submit(command)).toEqual(first);
    const savedAgain = join(root, "after-restart.html");
    await saveSessionExport(receipt, { endpoint: async () => ({ origin: host!.connection.origin, token: host!.connection.token, hostId: source.hostId }), choose: async () => savedAgain, current() {} });
    expect(await readFile(savedAgain)).toEqual(await readFile(destination));
  } finally { await host?.stop(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
