// Actual native schema/files in an isolated HOME. No provider requests or user
// credentials: the labelled concealed values only verify row association.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OmpModelDefinitionsSnapshot, SettingJson } from "@agent-desktop/shared";
import { OmpModelDefinitionsStore } from "../model-definitions";

const [agentDir] = process.argv.slice(2);
const file = path.join(agentDir, "models.yml");
const location = ["providers", "contract-duplicates"];
const modelPath = [...location, "models"];
const store = new OmpModelDefinitionsStore(agentDir);
const provider = (snapshot: OmpModelDefinitionsSnapshot): Record<string, any> => (snapshot.document.providers as Record<string, any>)["contract-duplicates"];
const raw = async (): Promise<any> => Bun.YAML.parse(await readFile(file, "utf8"));
const models = (document: any): any[] => document.providers["contract-duplicates"].models;
const secrets = (document: any) => models(document).map(model => [model.headers["X-Contract"], model.compat.extraBody.private]);
const first = ["contract-first-header", "contract-first-body"], second = ["contract-second-header", "contract-second-body"];
globalThis.fetch = Object.assign(async () => { throw new Error("Provider calls forbidden in duplicate model contract"); }, { preconnect: () => {} }) as typeof fetch;

await writeFile(file, Bun.YAML.stringify({ providers: { "contract-duplicates": {
  baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", auth: "none",
  models: [first, second].map(([header, body], index) => ({ id: "same-native-id", name: `Row ${index + 1}`, headers: { "X-Contract": header }, compat: { supportsStore: false, extraBody: { private: body } } })),
} } }));
try {
  let snapshot = (await store.read()).snapshot;
  assert(!JSON.stringify(snapshot).includes(first[0])); assert(!JSON.stringify(snapshot).includes(second[1]));
  // The revision anchors this exact index, even though native IDs collide.
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...modelPath, 1], operation: "set", value: { ...provider(snapshot).models[1], name: "Edited second row" } }] });
  assert.equal(models(await raw())[1].name, "Edited second row");
  assert.deepEqual(secrets(await raw()), [first, second]);
  // Editing provider fields includes an unchanged public model array. It must
  // retain each row by index instead of matching both rows to the first ID.
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: location, operation: "set", value: { ...provider(snapshot), disableStrictTools: true } }] });
  assert.deepEqual(secrets(await raw()), [first, second]);
  const beforeReorder = await readFile(file, "utf8");
  for (const replacement of [provider(snapshot).models, [...provider(snapshot).models].reverse()]) {
    await assert.rejects(store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: modelPath, operation: "set", value: replacement }] }), /Duplicate native model IDs.*ambiguous/);
    assert.equal(await readFile(file, "utf8"), beforeReorder);
  }
  await assert.rejects(store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: location, operation: "set", value: { ...provider(snapshot), models: [...provider(snapshot).models].reverse() } }] }), /Duplicate native model IDs.*ambiguous/);
  assert.equal(await readFile(file, "utf8"), beforeReorder);
  // An external writer can reorder native rows; a previous index is then stale.
  const external = await raw(); models(external).reverse(); await writeFile(file, Bun.YAML.stringify(external));
  const externallyReordered = await readFile(file, "utf8");
  await assert.rejects(store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...modelPath, 1], operation: "set", value: { ...provider(snapshot).models[1], name: "Must not reach wrong row" } }] }), /changed; reload/);
  assert.equal(await readFile(file, "utf8"), externallyReordered);
  snapshot = (await store.read()).snapshot;
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: [...modelPath, 0], operation: "set", value: { ...provider(snapshot).models[0], name: "Current first row", id: "distinct-native-id" } as SettingJson }] });
  assert.deepEqual(secrets(await raw()), [second, first]);
  // Giving the exact row a distinct ID makes a subsequent reorder unambiguous.
  snapshot = await store.mutate({ expectedRevision: snapshot.revision, changes: [{ path: modelPath, operation: "set", value: [...provider(snapshot).models].reverse() }] });
  assert.deepEqual(secrets(await raw()), [first, second]);
  assert.deepEqual(models(await raw()).map(model => model.id), ["same-native-id", "distinct-native-id"]);
  process.stdout.write("native settings contracts passed (duplicate model IDs)\n");
} finally { await store.dispose(); }
