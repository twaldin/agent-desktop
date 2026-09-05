import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameSnapshot, type BrowserMetadataSnapshot } from "@agent-desktop/shared";
import { BrowserFrameHttp } from "../browser-frame-http";
import { BrowserMetadataHttp } from "../browser-metadata-http";
import { WorkerRuntime } from "./runtime";

async function browserExecutable(): Promise<string> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && (await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(() => undefined))?.isFile()) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const root of [join(homedir(), ".omp/puppeteer/chrome"), join(homedir(), ".cache/puppeteer/chrome")]) for (const version of (await readdir(root).catch(() => [])).sort().reverse()) {
    const candidate = join(root, version, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  throw new Error("Native browser frame contract requires an existing Chrome for Testing executable");
}

test("real owner-bound worker captures its native OMP tab without changing page identity or state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-browser-frame-native-")), agentDir = join(root, "agent"), cwd = join(root, "project");
  await Promise.all([agentDir, cwd].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  const extension = fileURLToPath(new URL("./fixtures/browser-frame-extension.ts", import.meta.url));
  await writeFile(join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\nbrowser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n`);
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    requests.push(new URL(request.url).pathname);
    return new Response(`<!doctype html><meta charset="utf-8"><title>Native frame page</title><style>html,body{margin:0;width:100%;height:100%;background:#13579b;color:white}</style><main>frame proof</main><script>globalThis.browserFrameState={token:'unchanged',count:7}</script>`, { headers: { "Content-Type": "text/html" } });
  } });
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/local-browser-worker.ts", import.meta.url)), environment: {
    HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb", PUPPETEER_EXECUTABLE_PATH: await browserExecutable(), BROWSER_FRAME_TEST_URL: `http://127.0.0.1:${server.port}/page`, PI_BROWSER_CMUX: "0", PI_BROWSER_RELAY: "0",
  } });
  try {
    const session = await runtime.create({ cwd, interactions: true }); const sessionId = session.id;
    const opened = session.startPrompt("/open-browser-frame-contract"); expect(await opened.accepted).toEqual({ kind: "native-command", command: "open-browser-frame-contract" }); await opened.completion;
    const metadataEndpoint = new BrowserMetadataHttp({ hostId: "owner", sessionExists: id => id === sessionId, getExistingHandle: async id => id === sessionId ? session : undefined });
    const metadataResponse = await metadataEndpoint.route(new Request(`http://host/v1/sessions/${sessionId}/browser-metadata`, { headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }));
    const metadata = await metadataResponse!.json() as BrowserMetadataSnapshot; expect(metadata.availability).toBe("running"); if (metadata.availability !== "running") throw new Error("Expected running native browser metadata");
    const tab = metadata.tabs[0]!; expect(tab).toMatchObject({ name: "native-frame-proof", backend: "worker", state: "alive", url: `http://127.0.0.1:${server.port}/page` });
    const target = { workerPid: metadata.workerPid, name: tab.name, targetId: tab.targetId };
    await expect(session.getBrowserFrame({ ...target, workerPid: target.workerPid + 1 })).rejects.toThrow("stale worker");
    await expect(session.getBrowserFrame({ ...target, targetId: `${target.targetId}-stale` })).rejects.toThrow("no longer available");
    const frameEndpoint = new BrowserFrameHttp({ hostId: "owner", sessionExists: id => id === sessionId, getExistingHandle: async id => id === sessionId ? session : undefined });
    const query = new URLSearchParams({ workerPid: String(target.workerPid), name: target.name, targetId: target.targetId });
    const response = await frameEndpoint.route(new Request(`http://host/v1/sessions/${sessionId}/browser-frame?${query}`, { headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }));
    expect(response?.status).toBe(200); const frame = await response!.json() as BrowserFrameSnapshot;
    expect(frame).toMatchObject({ protocolVersion: 1, hostId: "owner", sessionId, workerPid: session.workerPid, name: tab.name, targetId: tab.targetId, mimeType: "image/jpeg", width: 640, height: 480, url: tab.url, title: "Native frame page" }); expect(frame.data.length).toBeGreaterThan(100);
    const inspected = session.startPrompt("/inspect-browser-frame-contract"); expect(await inspected.accepted).toEqual({ kind: "native-command", command: "inspect-browser-frame-contract" }); await inspected.completion;
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const states = entries.filter(entry => entry.type === "custom" && entry.customType === "browser-frame-contract-state").map(entry => entry.data);
    expect(states).toHaveLength(2); expect(states[0]).toMatchObject({ phase: "before", url: tab.url, title: "Native frame page", viewport: { width: 640, height: 480, deviceScaleFactor: 1 }, state: { token: "unchanged", count: 7 } }); expect(states[1]).toEqual({ ...states[0], phase: "after" });
    expect(requests.filter(path => path === "/page")).toHaveLength(1); const after = await session.getBrowserMetadata(); expect(after.availability).toBe("running"); if (after.availability === "running") expect(after.tabs).toHaveLength(1);
  } finally { await runtime.dispose(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60_000);
