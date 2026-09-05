// In-process Request/Response route contract using real native stores/workers.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OmpSettingsSnapshot, OmpSessionControls } from "@agent-desktop/shared";
import { SettingsHttp } from "../../settings-http";
import { WorkerRuntime } from "../../omp-workers";
const [agentDir, cwd] = process.argv.slice(2);
globalThis.fetch = Object.assign(async () => { throw new Error("Provider calls forbidden in settings HTTP contract"); }, { preconnect: () => {} }) as typeof fetch;
const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("../../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)) });
const session = await runtime.create({ cwd });
const invalidations: unknown[] = [];
const otherCwd = path.join(cwd, "another-project"); await mkdir(otherCwd);
let holdCapabilities = false;
const capabilityStarted = Promise.withResolvers<void>(), releaseCapabilities = Promise.withResolvers<void>();
const http = new SettingsHttp({ agentDir, defaultCwd: cwd, maxBackends: 1,
  runtime: { listModelCapabilities: async (directory, options) => {
    if (holdCapabilities) { capabilityStarted.resolve(); await releaseCapabilities.promise; }
    return runtime.listModelCapabilities(directory, options);
  }, getComposerCatalog: (directory, options) => runtime.getComposerCatalog(directory, options) },
  resolveCwd: target => {
    if (target && "projectId" in target && target.projectId === "contract-project") return cwd;
    if (target && "projectId" in target && target.projectId === "other-project") return otherCwd;
    throw new Error("No catalog owner");
  }, getHandle: async id => {
    if (id !== session.id) throw new Error("No catalog session");
    return session;
  }, changed: event => invalidations.push(event),
});
const call = async (pathname: string, payload?: unknown) => {
  const url = new URL(pathname, "http://127.0.0.1");
  const request = payload === undefined ? new Request(url) : new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const response = await http.route(request, url);
  assert(response); assert.equal(response.headers.get("Cache-Control"), "no-store");
  return { status: response.status, data: await response.json() as any };
};
try {
  assert.equal((await call("/v1/settings/catalog")).data.settings.length, 484);
  const initial = (await call("/v1/settings/read", {})).data as OmpSettingsSnapshot;
  const mutation = { expectedRevision: initial.revision, scope: "global", path: "hindsight.apiToken", operation: "set", value: "contract-http-private-token" };
  const changed = await call("/v1/settings/mutate", { mutation });
  assert.equal(changed.status, 200);
  assert(!JSON.stringify(changed.data).includes("contract-http-private-token"));
  assert(!JSON.stringify(invalidations).includes("contract-http-private-token"));
  assert.deepEqual(invalidations, [{ target: undefined, scope: "global" }]);
  assert.equal((await call("/v1/settings/mutate", { mutation })).status, 409);
  assert.equal((await call("/v1/settings/read", { target: { projectId: "unknown-catalog-id" } })).status, 400);
  assert.equal((await call("/v1/settings/read", { target: { cwd: "/arbitrary-path" } })).status, 400);
  assert.equal((await call("/v1/settings/read", { cwd: "/arbitrary-path" })).status, 400);
  const project = (await call("/v1/settings/read", { target: { projectId: "contract-project" } })).data as OmpSettingsSnapshot;
  assert.equal((await call("/v1/settings/mutate", { target: { projectId: "contract-project" }, mutation: {
    expectedRevision: project.revision, scope: "project", path: "compaction.enabled", operation: "set", value: false,
  } })).status, 200);
  const modes = await call("/v1/settings/options", { path: "tools.approvalMode" });
  assert(modes.data.options.some((option: any) => option.value === "always-ask"));
  const controls = (await call(`/v1/sessions/${session.id}/controls`)).data as OmpSessionControls;
  const overridden = await call(`/v1/sessions/${session.id}/controls`, { expectedRevision: controls.revision, operation: "override", path: "tools.approvalMode", value: "always-ask" });
  assert.equal(overridden.status, 200);
  assert.equal(overridden.data.settings.find((entry: any) => entry.path === "tools.approvalMode").effective, "always-ask");
  assert(!JSON.stringify(invalidations).includes("always-ask"));
  const secretOverride = await call(`/v1/sessions/${session.id}/controls`, { expectedRevision: overridden.data.revision, operation: "override", path: "auth.broker.token", value: "contract-http-private-token" });
  assert.equal(secretOverride.status, 400); assert(!JSON.stringify(secretOverride.data).includes("contract-http-private-token"));
  assert((await call("/v1/models/capabilities", { target: { projectId: "contract-project" } })).data.length > 0);
  const composer = await call("/v1/models/composer", { target: { projectId: "contract-project" }, refresh: true });
  assert.equal(composer.status, 200); assert.equal(composer.data.cwd, cwd);
  assert(composer.data.models.length > 0); assert.equal(composer.data.resolution, "native-registry-preview");
  assert(!JSON.stringify(composer.data).includes("contract-http-private-token"));
  assert.equal((await call("/v1/models/composer", { target: { projectId: "unknown" } })).status, 400);
  assert.equal((await call("/v1/models/composer", { target: { cwd } })).status, 400);
  assert.equal((await call("/v1/models/composer", { cwd })).status, 400);
  assert.equal((await call("/v1/models/composer", { refresh: "yes" })).status, 400);
  assert.equal((await call("/v1/settings/read", { junk: "x".repeat(1024 * 1024) })).status, 400);
  assert.equal(await http.route(new Request("http://127.0.0.1/unrelated"), new URL("http://127.0.0.1/unrelated")), undefined);
  // A discovery request leases its service; a different project cannot evict it
  // or make its concurrent mutation's revision disappear.
  const cached = (await call("/v1/settings/read", {})).data;
  holdCapabilities = true;
  const held = call("/v1/models/capabilities", {});
  await capabilityStarted.promise;
  assert.equal((await call("/v1/settings/read", { target: { projectId: "other-project" } })).status, 503);
  assert.equal((await call("/v1/settings/read", {})).data.revision, cached.revision);
  releaseCapabilities.resolve(); await held; holdCapabilities = false;
  assert.equal((await call("/v1/settings/read", { target: { projectId: "other-project" } })).status, 200);
  assert.equal((await call("/v1/settings/mutate", { mutation: {
    expectedRevision: cached.revision, scope: "global", path: "compaction.enabled", operation: "set", value: false,
  } })).status, 409); // Evicted opaque revisions safely require a reload.
  process.stdout.write("native settings contracts passed (HTTP route)\n");
} finally { await http.dispose(); await runtime.dispose(); }
