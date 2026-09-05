// Actual native files/schema/registry, isolated HOME, no provider requests.
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmpModelDefinitionsStore } from "../model-definitions";
import { WorkerRuntime } from "../../omp-workers";
import { SettingsHttp } from "../../settings-http";
import type { OmpModelDefinitionsSnapshot, SettingJson } from "@agent-desktop/shared";
const [agentDir, cwd] = process.argv.slice(2);
globalThis.fetch = Object.assign(async () => { throw new Error("Provider calls forbidden in model definition contract"); }, { preconnect: () => {} }) as typeof fetch;
const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("../../omp-workers/fixtures/no-provider-worker.ts", import.meta.url)) });
const store = new OmpModelDefinitionsStore(agentDir);
const second = new OmpModelDefinitionsStore(agentDir);
const file = path.join(agentDir, "models.yml");
const provider = "contract-provider";
const location = ["providers", provider];
function value(snapshot: OmpModelDefinitionsSnapshot): Record<string, any> { return (snapshot.document.providers as Record<string, any>)[provider]; }
try {
  let loaded = await store.read(); assert.equal(loaded.snapshot.format, "missing");
  assert.equal(loaded.catalog.validator, "native-models-config-schema-and-provider-validation");
  assert.equal(loaded.catalog.schema.kind, "object");
  const definition: Record<string, SettingJson> = { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", auth: "none", apiKey: "contract-provider-secret", headers: { Authorization: "contract-header-secret" }, models: [
    { id: "contract-first", name: "Contract first model", reasoning: true, contextWindow: 32000, maxTokens: 1000, thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" }, headers: { "X-Model": "contract-first-secret" }, compat: { supportsStore: false, whenThinking: { supportsReasoningEffort: true }, openRouterRouting: { only: ["contract-route"], order: ["contract-route"] }, extraBody: { private: "contract-body-secret" } } },
    { id: "contract-second", name: "Contract second model", headers: { "X-Model": "contract-second-secret" } },
  ], modelOverrides: { "contract-first": { compat: { vercelGatewayRouting: { order: ["contract-gateway"] }, whenThinking: { extraBody: { private: "contract-nested-secret" } } } } } };
  let snapshot = await store.mutate({ expectedRevision: loaded.snapshot.revision, changes: [{ path: location, operation: "set", value: definition }] });
  const response = JSON.stringify(snapshot); assert(!response.includes("contract-provider-secret")); assert(!response.includes("contract-header-secret")); assert(!response.includes("contract-body-secret")); assert(!response.includes("contract-nested-secret")); assert(!response.includes("127.0.0.1:9"));
  assert(snapshot.concealed.some(field => field.path.at(-1) === "apiKey" && field.configured));
  const original = await readFile(file, "utf8");
  await assert.rejects(store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...location, "models", 0, "maxTokens"], operation: "set", value: -1 }] }), /native model validator/);
  await assert.rejects(store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...location, "discovery"], operation: "set", value: { type: "ollama", injectV1: true } }] }), /native model validator/);
  await assert.rejects(store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: location, operation: "set", value: { ...definition, madeUpSecretField: "contract-must-not-echo" } }] }), /absent from the pinned/);
  assert.equal(await readFile(file, "utf8"), original);
  const beforeModels = await runtime.listModels(cwd);
  assert(beforeModels.some(model => model.provider === provider && model.id === "contract-first" && model.name === "Contract first model"));
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...location, "models", 0], operation: "set", value: { ...value(snapshot).models[0], name: "Contract edited model", maxTokens: 1500 } }] });
  let raw = Bun.YAML.parse(await readFile(file, "utf8")) as any;
  assert.equal(raw.providers[provider].models[0].headers["X-Model"], "contract-first-secret");
  assert.equal(raw.providers[provider].models[0].compat.extraBody.private, "contract-body-secret");
  const refreshed = await runtime.listModelCapabilities(cwd, { refresh: true });
  assert.equal(refreshed.find(model => model.provider === provider && model.id === "contract-first")?.maxTokens, 1500);
  assert.equal(refreshed.find(model => model.provider === provider && model.id === "contract-first")?.name, "Contract edited model");
  // Reordering the model array retains each model's opaque fields by native id.
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...location, "models"], operation: "set", value: [...value(snapshot).models].reverse() }] });
  raw = Bun.YAML.parse(await readFile(file, "utf8")) as any;
  assert.equal(raw.providers[provider].models[0].id, "contract-second"); assert.equal(raw.providers[provider].models[0].headers["X-Model"], "contract-second-secret");
  assert.equal(raw.providers[provider].models[1].headers["X-Model"], "contract-first-secret");
  // A nested compatibility edit preserves its concealed extraBody. Explicit
  // removal clears it; native input normalization still validates thinking.
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [
    { path: [...location, "models", 1, "compat"], operation: "set", value: { openRouterRouting: { only: ["edited-route"] } } },
    { path: [...location, "apiKey"], operation: "remove" },
  ] });
  raw = Bun.YAML.parse(await readFile(file, "utf8")) as any; assert.equal(raw.providers[provider].apiKey, undefined); assert.equal(raw.providers[provider].models[1].compat.extraBody.private, "contract-body-secret");
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...location, "models", 1, "compat", "extraBody"], operation: "remove" }] });
  assert(!JSON.stringify(Bun.YAML.parse(await readFile(file, "utf8"))).includes("contract-body-secret"));
  const oneRevision = snapshot.revision, twoRevision = (await second.read()).snapshot.revision;
  const raced = await Promise.allSettled([
    store.mutate({ expectedRevision: oneRevision, changes: [{ path: [...location, "models", 0, "name"], operation: "set", value: "First client" }] }),
    second.mutate({ expectedRevision: twoRevision, changes: [{ path: [...location, "models", 0, "name"], operation: "set", value: "Second client" }] }),
  ]);
  assert.equal(raced.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(raced.filter(result => result.status === "rejected").length, 1);
  // Preserve native symlink, mode and ownership across actual atomic replacement.
  const actualTarget = path.join(agentDir, "linked-native-models.yml"); await rename(file, actualTarget); await chmod(actualTarget, 0o640); await symlink(actualTarget, file);
  const metadata = await stat(actualTarget); snapshot = (await store.read()).snapshot;
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...location, "models", 0, "name"], operation: "set", value: "Symlink preserved" }] });
  assert((await lstat(file)).isSymbolicLink()); const afterMetadata = await stat(actualTarget);
  assert.equal(afterMetadata.mode & 0o7777, metadata.mode & 0o7777); assert.equal(afterMetadata.uid, metadata.uid); assert.equal(afterMetadata.gid, metadata.gid);
  // Unknown existing extension fields remain on disk but never disclose values.
  raw = Bun.YAML.parse(await readFile(file, "utf8")) as any; raw.providers[provider].extensionOnly = { credential: "contract-unknown-private" }; await writeFile(file, Bun.YAML.stringify(raw));
  snapshot = (await store.read()).snapshot; assert(!JSON.stringify(snapshot).includes("contract-unknown-private")); assert(snapshot.unsupportedPaths.some(field => field.at(-1) === "extensionOnly"));
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: location, operation: "set", value: value(snapshot) as SettingJson }] });
  assert.equal((Bun.YAML.parse(await readFile(file, "utf8")) as any).providers[provider].extensionOnly.credential, "contract-unknown-private");
  const changes: unknown[] = [];
  const http = new SettingsHttp({ agentDir, defaultCwd: cwd, runtime, resolveCwd: () => { throw new Error("No path input expected"); }, getHandle: async () => { throw new Error("No session input expected"); }, changed: event => changes.push(event) });
  try {
    const url = new URL("http://127.0.0.1/v1/models/definitions");
    const loadedResponse = await http.route(new Request(url), url); assert.equal(loadedResponse?.status, 200); assert.equal(loadedResponse?.headers.get("Cache-Control"), "no-store");
    const safe = await loadedResponse!.json() as any; assert(!JSON.stringify(safe).includes("contract-unknown-private"));
    const mutation = { expectedRevision: safe.snapshot.revision, changes: [{ path: [...location, "headers"], operation: "set", value: { Authorization: "contract-http-new-secret" } }] };
    const writeResponse = await http.route(new Request(url, { method: "POST", body: JSON.stringify(mutation) }), url);
    assert.equal(writeResponse?.status, 200); assert(!JSON.stringify(await writeResponse!.json()).includes("contract-http-new-secret")); assert.deepEqual(changes, [{ scope: "global" }]);
    const bad = await http.route(new Request(url, { method: "POST", body: JSON.stringify({ ...mutation, target: { cwd: "/arbitrary/path" } }) }), url); assert.equal(bad?.status, 400);
  } finally { await http.dispose(); }
  const legacyDir = path.join(agentDir, "legacy"); await mkdir(legacyDir); const legacyFile = path.join(legacyDir, "models.json"); await writeFile(legacyFile, JSON.stringify({ providers: { legacy: { auth: "none" } } })); await chmod(legacyFile, 0o640);
  const legacy = new OmpModelDefinitionsStore(legacyDir);
  try {
    const before = await legacy.read(); assert.equal(before.snapshot.format, "legacy-json");
    await assert.rejects(stat(path.join(legacyDir, "models.yml")), /ENOENT/);
    const changed = await legacy.mutate({ expectedRevision: before.snapshot.revision, changes: [{ path: ["providers", "legacy", "disableStrictTools"], operation: "set", value: true }] });
    assert.equal(changed.format, "yml"); assert.equal((await stat(changed.sourcePath)).mode & 0o7777, 0o640); assert((await readFile(legacyFile, "utf8")).includes("legacy"));
  } finally { await legacy.dispose(); }
  process.stdout.write("native settings contracts passed (model definitions)\n");
} finally { await store.dispose(); await second.dispose(); await runtime.dispose(); }
