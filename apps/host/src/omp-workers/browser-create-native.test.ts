import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserCreateHttp } from "../browser-create-http";
import { requestBrowserCreate } from "../../../desktop/src/main/browser-create-transport";
import { WorkerRuntime } from "./runtime";

async function browserExecutable(): Promise<string> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && (await stat(process.env.PUPPETEER_EXECUTABLE_PATH).catch(() => undefined))?.isFile()) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  for (const root of [join(homedir(), ".omp/puppeteer/chrome"), join(homedir(), ".cache/puppeteer/chrome")]) {
    for (const version of (await readdir(root).catch(() => [])).sort().reverse()) {
      const candidate = join(root, version, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
    }
  }
  throw new Error("Native browser creation contract requires an existing Chrome for Testing executable");
}

test("actual worker creates an owner-bound tab from its native AgentSession settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-browser-create-native-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await Promise.all([agentDir, cwd].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  await writeFile(join(agentDir, "config.yml"), "browser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n");
  const runtime = new WorkerRuntime({ agentDir, environment: {
    HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb",
    PUPPETEER_EXECUTABLE_PATH: await browserExecutable(), PI_BROWSER_CMUX: "0", PI_BROWSER_RELAY: "0",
  } });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const session = await runtime.create({ cwd, interactions: true });
    const requestId = crypto.randomUUID();
    const name = `desktop-${requestId}`;
    const controlEpoch = crypto.randomUUID();
    const http = new BrowserCreateHttp({ hostId: "owner", controlEpoch, sessionExists: id => id === session.id,
      getHandle: async () => session, getExistingHandle: async () => session });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      return (await http.route(request)) ?? new Response("", { status: 404 });
    } });
    const created = await requestBrowserCreate({ hostId: "owner", origin: server.url.origin, token: "fixture-token" },
      session.id, { requestId, controlEpoch, observedAt: Date.now() });
    expect(created.outcome).toBe("completed");
    if (created.outcome !== "completed") throw new Error("Expected completed native browser creation");
    expect(created).toMatchObject({ targetDisposition: "created-page", tab: {
      name, backend: "worker", kindTag: "headless", state: "alive", url: "about:blank",
    } });
    expect(created.tab.targetId.length).toBeGreaterThan(0);
    expect(created.tab.viewport.width).toBeGreaterThan(0);
    const metadata = await session.getBrowserMetadata();
    expect(metadata.availability).toBe("running");
    if (metadata.availability === "running") {
      expect(metadata.workerPid).toBe(session.workerPid);
      expect(metadata.tabs).toContainEqual(created.tab);
    }
    await expect(session.createBrowserTab(name)).rejects.toMatchObject({ name: "BrowserTabCreateRejected" });
    const after = await session.getBrowserMetadata();
    expect(after.availability === "running" ? after.tabs.filter(tab => tab.name === name) : []).toHaveLength(1);
  } finally {
    server?.stop(true);
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
