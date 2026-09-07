import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionSummary } from "@agent-desktop/shared";
import { startHost } from "./server";

test("reopening a worker publishes its native model over stale summary metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-session-model-reopen-"));
  const dataDirectory = join(root, "data"), agentDirectory = join(root, "agent"), project = join(root, "project");
  await Promise.all([agentDirectory, project].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  await writeFile(join(agentDirectory, "config.yml"), "extensions: []\n");
  const fixture = join(root, "worker.ts");
  await writeFile(fixture, `process.env.HOME=${JSON.stringify(root)};\nprocess.env.XDG_CONFIG_HOME=${JSON.stringify(join(root, "xdg-config"))};\nprocess.env.XDG_DATA_HOME=${JSON.stringify(join(root, "xdg-data"))};\nawait import(${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/no-provider-worker.ts", import.meta.url)))});\n`);
  const options = { dataDirectory, agentDirectory, discoveryDirectory: project, workerPath: fixture, tailscale: false, port: 0 };
  let host = await startHost(options);
  try {
    const created = await host.dispatch({ id: "create", command: { type: "session.create", projectId: null, cwd: project } });
    if (!created.ok || !created.value || !("sessionFile" in created.value)) throw new Error("Expected a native session");
    const session = created.value as SessionSummary;
    const nativeModel = session.model;
    host.store.upsertSession({ ...session, model: { provider: "stale-history", id: "historical-model" } });
    await host.stop();
    host = await startHost(options);
    expect(host.store.getSession(session.id)?.model).toEqual({ provider: "stale-history", id: "historical-model" });

    const response = await fetch(`${host.connection.origin}/v1/sessions/${session.id}/controls`, {
      headers: { Authorization: `Bearer ${host.connection.token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { model: SessionSummary["model"] }).model).toEqual(nativeModel);
    expect(host.store.getSession(session.id)?.model).toEqual(nativeModel);
    expect(host.snapshot().sessions.find(item => item.id === session.id)?.model).toEqual(nativeModel);
    // Synchronizing runtime metadata must not make an old conversation look newly active.
    expect(host.store.getSession(session.id)?.updatedAt).toBe(session.updatedAt);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
