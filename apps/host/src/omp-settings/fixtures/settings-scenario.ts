// Native configuration only, explicitly temporary HOME/project; no providers.
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OmpSettings } from "../store";
import { settingsCatalog, validateSettingValue, requireSetting } from "../schema";
globalThis.fetch = Object.assign(async () => { throw new Error("Provider calls forbidden in settings contract"); }, { preconnect: () => {} }) as typeof fetch;
const [agentDir, cwd] = process.argv.slice(2);
const configFile = path.join(agentDir, "config.yml");
const service = await OmpSettings.open({ agentDir, cwd });
try {
  const catalog = settingsCatalog();
  assert.equal(catalog.settings.length, 484);
  assert.equal(new Set(catalog.settings.map(item => item.path)).size, 484);
  for (const descriptor of catalog.settings) {
    assert(descriptor.schema); assert(descriptor.control); assert(descriptor.scopes.length);
    if (descriptor.defaultValue !== undefined) validateSettingValue(requireSetting(descriptor.path), descriptor.defaultValue);
    if (descriptor.credential) assert(!Object.hasOwn(descriptor, "defaultValue"));
  }
  let snapshot = await service.read();
  assert.equal(snapshot.entries.length, 484);
  const original = await readFile(configFile, "utf8");
  await assert.rejects(service.mutate({ expectedRevision: snapshot.revision, scope: "global", path: "tools.approvalMode", operation: "set", value: "made-up" }), /native type/);
  await assert.rejects(service.mutate({ expectedRevision: snapshot.revision, scope: "global", path: "providers.maxInFlightRequests", operation: "set", value: { openai: -1 } }), /positive/);
  assert.equal(await readFile(configFile, "utf8"), original);
  const firstRevision = snapshot.revision;
  snapshot = await service.mutate({ expectedRevision: snapshot.revision, scope: "global", path: "tools.approvalMode", operation: "set", value: "always-ask" });
  assert.notEqual(snapshot.revision, firstRevision);
  assert.equal((await Settings.loadReadOnly({ agentDir, cwd })).get("tools.approvalMode"), "always-ask");
  await assert.rejects(service.mutate({ expectedRevision: firstRevision, scope: "global", path: "tools.approvalMode", operation: "set", value: "yolo" }), /changed/);
  snapshot = await service.mutate({ expectedRevision: snapshot.revision, scope: "project", path: "compaction.enabled", operation: "set", value: false });
  assert.equal((await Settings.loadReadOnly({ agentDir, cwd })).get("compaction.enabled"), false);
  assert.equal(snapshot.entries.find(entry => entry.path === "compaction.enabled")?.effective, false);
  snapshot = await service.mutate({ expectedRevision: snapshot.revision, scope: "global", path: "hindsight.apiToken", operation: "set", value: "contract-private-setting-token" });
  const secret = snapshot.entries.find(entry => entry.path === "hindsight.apiToken")!;
  assert.equal(secret.configured, true); assert.equal(secret.globalConfigured, true);
  assert(!Object.hasOwn(secret, "effective")); assert(!Object.hasOwn(secret, "global"));
  assert(!JSON.stringify(snapshot).includes("contract-private-setting-token"));
  assert.match(snapshot.revision, /^[a-f0-9-]{36}$/);
  snapshot = await service.mutate({ expectedRevision: snapshot.revision, scope: "global", path: "hindsight.apiToken", operation: "reset" });
  assert.equal(snapshot.entries.find(entry => entry.path === "hindsight.apiToken")?.configured, false);
  snapshot = await service.mutate({ expectedRevision: snapshot.revision, scope: "global", path: "tools.approvalMode", operation: "reset" });
  assert.equal(snapshot.entries.find(entry => entry.path === "tools.approvalMode")?.global, "yolo");
  // External changes invalidate an existing client revision without dumping config.
  const beforeExternal = snapshot.revision;
  await writeFile(configFile, (await readFile(configFile, "utf8")) + "\nsearxng:\n  token: contract-external-token\n");
  await assert.rejects(service.mutate({ expectedRevision: beforeExternal, scope: "global", path: "compaction.enabled", operation: "set", value: true }), /changed/);
  const renewed = await OmpSettings.open({ agentDir, cwd });
  const resumed = await renewed.read();
  assert.equal(resumed.entries.find(entry => entry.path === "compaction.enabled")?.effective, false);
  assert(!JSON.stringify(resumed).includes("contract-external-token"));
  await renewed.dispose();
  // Preserve existing valid symlinks when the project file is edited.
  const projectFile = path.join(cwd, ".omp", "config.yml");
  const target = path.join(cwd, "native-project-settings.yml");
  await writeFile(target, await readFile(projectFile, "utf8"));
  await import("node:fs/promises").then(fs => fs.rm(projectFile));
  await symlink(target, projectFile);
  snapshot = await service.read();
  snapshot = await service.mutate({ expectedRevision: snapshot.revision, scope: "project", path: "compaction.enabled", operation: "reset" });
  assert.equal((await import("node:fs/promises").then(fs => fs.lstat(projectFile))).isSymbolicLink(), true);
  assert.equal(snapshot.entries.find(entry => entry.path === "compaction.enabled")?.effective, true);
  process.stdout.write("native settings contracts passed\n");
} finally { await service.dispose(); }
