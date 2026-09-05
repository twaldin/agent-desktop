import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserMetadataSnapshot } from "@agent-desktop/shared";
import { BrowserMetadataHttp } from "./browser-metadata-http";
import { WorkerRuntime } from "./omp-workers/runtime";

test("the real worker entry returns patched metadata through the owner-bound host route without a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-browser-metadata-native-"));
  const agentDir = join(root, "agent"), cwd = join(root, "project"), sessionId = "native-session";
  await Promise.all([agentDir, cwd].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(agentDir, "config.yml"), "extensions: []\n");
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./omp-workers/fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  try {
    const session = await runtime.create({ cwd, interactions: true });
    const endpoint = new BrowserMetadataHttp({ hostId: "owner", sessionExists: id => id === sessionId, getExistingHandle: async id => id === sessionId ? session : undefined });
    const response = await endpoint.route(new Request(`http://host/v1/sessions/${sessionId}/browser-metadata`, { headers: { [BROWSER_METADATA_OWNER_HEADER]: "owner" } }));
    expect(response?.status).toBe(200);
    const metadata = await response!.json() as BrowserMetadataSnapshot;
    expect(metadata).toMatchObject({ availability: "running", hostId: "owner", sessionId });
    if (metadata.availability !== "running") throw new Error("Expected patched native metadata.");
    expect(metadata.workerPid).toBe(session.workerPid);
    expect(metadata.tabs).toEqual([]);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
