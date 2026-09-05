// Real CLI signal path with isolated HOME/app/native directories. Only the
// unrelated Tailscale executable is unavailable; no live service is contacted.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHostLease } from "./lease";
import type { LocalConnection } from "./paths";

const entry = fileURLToPath(new URL("./server.ts", import.meta.url));
async function until<T>(probe: () => Promise<T | undefined>, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe(); if (value !== undefined) return value; await Bun.sleep(20); }
  throw new Error("Isolated CLI condition timed out");
}
async function childPids(parent: number): Promise<number[]> {
  const ps = Bun.spawn(["/bin/ps", "-ax", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(ps.stdout).text(); await ps.exited;
  return text.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === parent).map(([pid]) => pid!);
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function signalContract(signal: "SIGTERM" | "SIGINT", stalledDiscovery = false): Promise<void> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-signal-")));
  const data = path.join(directory, "data"), agent = path.join(directory, "agent"), bin = path.join(directory, "bin");
  await Promise.all([data, agent, bin].map(value => mkdir(value)));
  await writeFile(path.join(agent, "config.yml"), "extensions: []\n");
  let discoveryRequested = false;
  const replies: Array<(response: Response) => void> = [];
  const provider = stalledDiscovery ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    discoveryRequested = true; return new Promise<Response>(resolve => { replies.push(resolve); });
  } }) : undefined;
  if (provider) await writeFile(path.join(agent, "models.yml"), Bun.YAML.stringify({ providers: { "contract-stalled": {
    baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", auth: "none", discovery: { type: "openai-models-list", timeoutMs: 30_000 },
  } } }));
  const tailscale = path.join(bin, "tailscale"); await writeFile(tailscale, "#!/bin/sh\nexit 1\n"); await chmod(tailscale, 0o700);
  const child = Bun.spawn([process.execPath, entry], {
    cwd: directory, env: { HOME: directory, PATH: `${bin}:/usr/bin:/bin`, SHELL: "/bin/sh", TMPDIR: tmpdir(), TERM: "dumb", PI_CODING_AGENT_DIR: agent, AGENT_DESKTOP_DATA_DIR: data },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  let pendingRefresh: Promise<unknown> | undefined;
  let owned: number[] = [];
  try {
    const connection = await until(async () => {
      if (child.exitCode !== null) throw new Error(`Isolated CLI exited before readiness (${child.exitCode}): ${await stderr}`);
      try { const value = JSON.parse(await readFile(path.join(data, "connection.json"), "utf8")) as LocalConnection;
        if (value.pid !== child.pid) return;
        const response = await fetch(value.origin + "/v1/health", { headers: { Authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) return value;
      } catch { /* The real CLI has not published readiness yet. */ }
    });
    if (stalledDiscovery) {
      pendingRefresh = fetch(connection.origin + "/v1/models/capabilities", { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ refresh: true }), signal: AbortSignal.timeout(10_000) }).then(response => response.arrayBuffer()).catch(() => {});
      await until(async () => discoveryRequested ? true : undefined);
    }
    owned = await until(async () => { const pids = await childPids(child.pid); return pids.length ? pids : undefined; });
    expect(owned.length).toBeGreaterThan(0);
    child.kill(signal);
    const code = await Promise.race([child.exited, Bun.sleep(7000).then(() => { throw new Error(`Isolated CLI did not finish ${signal} cleanup before the native 10s deadline`); })]);
    expect(code).toBe(signal === "SIGTERM" ? 143 : 130);
    expect(await stat(path.join(data, "connection.json")).then(() => true, () => false), `${signal} must remove connection.json before native hard exit`).toBe(false);
    const lease = acquireHostLease(data); expect(lease.acquired).toBe(true); lease.release();
    await until(async () => owned.every(pid => !alive(pid)) ? true : undefined);
    expect(await fetch(connection.origin + "/v1/health", { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(500) }).then(() => true, () => false)).toBe(false);
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    for (const reply of replies) reply(new Response(null, { status: 503 }));
    provider?.stop(true);
    // Native workers also exit on owning IPC disconnect. Reap only this test's
    // known children before removing its private directories.
    await until(async () => owned.every(pid => !alive(pid)) ? true : undefined);
    await stderr;
    await pendingRefresh;
    await rm(directory, { recursive: true, force: true });
  }
}
test("CLI SIGTERM removes its locator, releases its lease and terminates owned discovery workers", () => signalContract("SIGTERM"), 15_000);
test("CLI SIGINT joins native cleanup and releases the same owned resources", () => signalContract("SIGINT"), 15_000);
test("CLI SIGTERM cancels stalled native model discovery before the native cleanup deadline", () => signalContract("SIGTERM", true), 20_000);
