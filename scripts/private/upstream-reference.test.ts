import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asarRows, fileEvidence, packageRoot, readJson, sourcePath } from "../upstream-artifacts";
import { capabilityRows, canonical, compareRows, settingRows, themeRows, visualRows, type Evidence } from "../upstream-inventory";
import { buildReport, parseArgs, renderMarkdown } from "../upstream-report";
const reference = resolve(import.meta.dir, "../../.reference"), release = join(reference, "omp-18.1.10-release"), codex = join(reference, "codex-26.901.41600");
const fixture: Evidence = { path: "/fixture/inventory.json", sha256: "fixture-data-only" };

async function temp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "upstream-report-test-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
describe("on-demand static upstream report", () => {
  test("the real preserved release → main setting delta is one addition with exact native attribution", async () => {
    const a = await readJson(join(release, "settings-inventory.json")), b = await readJson(join(reference, "omp-18.1.10/settings-inventory.json"));
    const delta = compareRows("settings", "settings", settingRows(a.value, a.evidence), settingRows(b.value, b.evidence), [a.evidence, b.evidence]);
    expect(delta.status).toBe("changed");
    expect(delta.counts).toEqual({ before: 484, after: 485, added: 1, removed: 0, changed: 0 });
    expect(delta.deltas?.[0]?.id).toBe("retry.waitForUsageReset");
    expect(delta.deltas?.[0]?.sources[0]?.url).toContain("5964a0f7649275bcde818f20073193fd032451f2");
    expect(delta.deltas?.[0]?.after?.defaultExpression).toBe("false");
  });
  test("pinned model/provider inventories agree despite changed source-line attribution", async () => {
    for (const filename of ["model-capabilities-inventory.json", "provider-options-inventory.json"]) {
      const a = await readJson(join(release, filename)), b = await readJson(join(reference, "omp-18.1.10", filename));
      const delta = compareRows(filename, filename, capabilityRows(a.value, a.evidence), capabilityRows(b.value, b.evidence), [a.evidence, b.evidence]);
      expect(delta.status).toBe("unchanged"); expect(delta.counts!.before).toBeGreaterThan(100);
    }
  });
  test("actual descriptor fixtures expose removals, type/default/enum/UI changes, with arrays ordered and no expression evaluation", async () => {
    const native = await readJson(join(release, "settings-inventory.json"));
    const a = structuredClone(native.value), b = structuredClone(native.value);
    const changed = b.settings.find((setting: any) => setting.path === "autoResume");
    changed.type = "enum"; changed.defaultExpression = "(() => { throw new Error('MUST NOT EXECUTE') })()";
    changed.enumValuesExpression = '["on", "off"]'; changed.ui.condition = "fixtureCondition";
    b.settings = b.settings.filter((setting: any) => setting.path !== "auth.broker.url");
    const result = compareRows("settings", "settings", settingRows(a, fixture), settingRows(b, fixture), [fixture]);
    expect(result.counts).toEqual({ before: 484, after: 483, added: 0, removed: 1, changed: 1 });
    expect(result.deltas!.find(delta => delta.id === "autoResume")?.facets).toEqual(["defaultExpression", "enumValuesExpression", "type", "ui"]);
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    expect(canonical(undefined)).not.toBe(canonical(null));
    expect(canonical("undefined")).not.toBe(canonical(undefined));
  });
  test("capability fixtures detect optionality, multiline declarations and configuration schema changes", async () => {
    const a = await readJson(join(release, "model-capabilities-inventory.json")), b = structuredClone(a.value);
    b.interfaces.Model.fields.find((field: any) => field.field === "supportsTools").optional = false;
    b.interfaces.Model.declarationExpression += "\n// explicit fixture declaration change";
    b.configurationSchemas.ModelDefinitionSchema.properties["contextWindow?"] = '"number > 0"';
    const result = compareRows("model", "model", capabilityRows(a.value, a.evidence), capabilityRows(b, fixture), [a.evidence, fixture]);
    expect(result.deltas!.find(delta => delta.id === "field:Model.supportsTools")?.facets).toEqual(["optional"]);
    expect(result.deltas!.find(delta => delta.id === "interface:Model")?.facets).toEqual(["declarationExpression"]);
    expect(result.deltas!.some(delta => delta.id === "configuration:ModelDefinitionSchema.contextWindow")).toBe(true);
  });
  test("duplicate/malformed inventory identities fail explicitly instead of dropping rows", async () => {
    const a = await readJson(join(release, "settings-inventory.json"));
    a.value.settings.push(structuredClone(a.value.settings[0]));
    expect(() => compareRows("settings", "settings", settingRows(a.value, fixture), [], [])).toThrow("Duplicate inventory identity");
    expect(() => settingRows({ settings: [{ path: "example", type: "string", value: "not a descriptor" }] }, fixture)).toThrow("missing defaultExpression");
    expect(() => sourcePath("/fixture", "../../config.yml")).toThrow("Invalid inventory source path");
  });
  test("the real Codex inventory retains duplicate selector declarations, cascade order, fonts and defaults", async () => {
    const a = await readJson(join(codex, "visual-token-inventory.json")), b = structuredClone(a.value);
    const token = b.custom_property_declarations.find((row: any) => row.name === "--color-text");
    expect(token).toBeDefined(); token.value_raw = "fixture-color";
    b.custom_property_declarations[0].source_order += 1;
    b.font_face_declarations[0].declarations[0].value_raw = "Fixture font";
    const delta = compareRows("visual", "visual", visualRows(a.value, a.evidence), visualRows(b, fixture), [a.evidence, fixture]);
    expect(delta.deltas!.some(row => row.id === "token:--color-text" && row.kind === "changed")).toBe(true);
    expect(delta.deltas!.some(row => row.id === "font:Fixture font" && row.kind === "added")).toBe(true);
    const defaults = await readJson(join(codex, "theme-defaults.json")), changed = structuredClone(defaults.value);
    changed.appearance_settings[0].default_expression = "`dark`";
    const setting = compareRows("theme", "theme", themeRows(defaults.value, defaults.evidence), themeRows(changed, fixture), []);
    expect(setting.deltas![0]?.facets).toEqual(["defaultExpression"]);
  });
  test("actual pinned archive hash/header are read without extraction or member execution", async () => {
    const meta = await readJson(join(codex, "reference-metadata.json"));
    const archive = await fileEvidence(join(codex, "app.asar")), rows = await asarRows(join(codex, "app.asar"));
    expect(archive.sha256).toBe(meta.value.appAsarSha256);
    const preserved = await readJson(join(codex, "asar-file-list.json"));
    expect(rows.length).toBe(preserved.value.length);
    const sample = rows.find(row => row.id === ".vite/build/early-bootstrap.js")!;
    expect(sample.facets.size).toBe(216);
    expect(sample.source.note).toContain("not verified");
  });
  test("malformed ASAR is bounded and rejected without allocating its declared payload", async () => temp(async dir => {
    const file = join(dir, "bad.asar"), header = Buffer.alloc(16);
    header.writeUInt32LE(4, 0); header.writeUInt32LE(0xfffffff0, 4); header.writeUInt32LE(0xffffffe0, 12);
    await writeFile(file, header); await expect(asarRows(file)).rejects.toThrow("Invalid ASAR header sizes");
  }));
  test("installed package lookup survives a real native import in an isolated process", async () => temp(async dir => {
    const repository = resolve(import.meta.dir, "../.."), coding = await packageRoot(repository, "@oh-my-pi/pi-coding-agent");
    const source = `
      import { strict as assert } from "node:assert";
      import { realpath } from "node:fs/promises";
      import { join } from "node:path";
      import { packageRoot, readJson } from ${JSON.stringify(join(import.meta.dir, "../upstream-artifacts.ts"))};
      await import(${JSON.stringify(join(coding, "src/session/session-manager.ts"))});
      for (const name of ["@oh-my-pi/pi-catalog", "@oh-my-pi/pi-agent-core"]) {
        const root = await packageRoot(${JSON.stringify(repository)}, name, ${JSON.stringify(coding)});
        assert.equal(root, await realpath(root));
        const artifact = await readJson(join(root, "package.json"));
        assert.equal(artifact.value.name, name);
        assert.equal(artifact.value.version, "18.1.10");
      }
      console.log("real native import preserves static package identity");
    `;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      cwd: repository, stdout: "pipe", stderr: "pipe",
      env: { HOME: dir, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: join(dir, "agent"), TERM: "dumb" },
    });
    const deadline = setTimeout(() => child.kill(), 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("real native import preserves static package identity");
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  }), 15_000);
  test("static dependency lookup follows the real Bun package directory without evaluating exports or scripts", async () => temp(async dir => {
    const repository = join(dir, "repo"), installed = join(repository, "node_modules/@fixture/consumer");
    const store = join(dir, "store/consumer/node_modules"), consumer = join(store, "@fixture/consumer"), dependency = join(dir, "packages/dependency");
    const decoy = join(repository, "node_modules/@fixture/dependency"), marker = join(dir, "should-not-exist");
    for (const directory of [consumer, dependency, decoy]) await mkdir(directory, { recursive: true });
    await symlink(consumer, installed);
    await symlink(dependency, join(store, "@fixture/dependency"));
    await writeFile(join(decoy, "package.json"), JSON.stringify({ name: "@fixture/dependency", version: "wrong-ancestor" }));
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "@fixture/dependency", version: "real-store", exports: "./must-not-run.ts", scripts: { postinstall: "exit 99" } }));
    await writeFile(join(dependency, "must-not-run.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed");`);
    const observed = await packageRoot(repository, "@fixture/dependency", installed);
    expect(observed).toBe(await realpath(dependency));
    expect((await readJson(join(observed, "package.json"))).value.version).toBe("real-store");
    await expect(readFile(marker)).rejects.toHaveProperty("code", "ENOENT");
  }));
  test("complete report compares real pinned inventories and never executes a supplied package or extractor", async () => temp(async dir => {
    const candidatePackage = join(dir, "candidate-package"); await mkdir(candidatePackage);
    const marker = join(dir, "should-not-exist");
    const malicious = `await Bun.write(${JSON.stringify(marker)}, "executed")`;
    await writeFile(join(candidatePackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "99.0.0", main: "index.ts", scripts: { postinstall: "exit 99" } }));
    await writeFile(join(candidatePackage, "index.ts"), malicious);
    const result = await buildReport({ ompCandidateInventory: join(reference, "omp-18.1.10"), ompCandidatePackage: candidatePackage, generatedAt: "fixture-time" });
    expect(result.checks.filter(check => check.status === "invalid")).toEqual([]);
    expect(result.summary.invalid).toBe(0); expect(result.summary.exitCode).toBe(2);
    expect(result.checks.find(check => check.id === "omp.candidate.settings-inventory.json")?.counts?.added).toBe(1);
    expect(result.checks.find(check => check.id === "omp.candidate-package")?.after).toBe("99.0.0");
    expect(result.checks.find(check => check.id === "compatibility.runtime")?.status).toBe("unknown");
    expect(result.checks.find(check => check.id === "omp.candidate-inventory-provenance")?.status).toBe("unknown");
    await expect(readFile(marker)).rejects.toHaveProperty("code", "ENOENT");
    const markdown = renderMarkdown(result);
    expect(markdown).toContain("retry.waitForUsageReset"); expect(markdown).toContain("No compatibility or visual parity pass");
    expect(markdown).toContain("5964a0f7649275bcde818f20073193fd032451f2");
  }), 15_000);
  test("candidate source digest mismatch is invalid, while absent descriptor files remain unknown", async () => temp(async dir => {
    await mkdir(join(dir, "sources"));
    await writeFile(join(dir, "sources/example.ts"), "changed candidate source");
    await writeFile(join(dir, "source-manifest.json"), JSON.stringify({ sourceCommit: "fixture-commit", sourceFiles: [{ path: "example.ts", sha256: "0".repeat(64), bytes: 24 }] }));
    const result = await buildReport({ ompCandidateInventory: dir });
    expect(result.summary.exitCode).toBe(1);
    expect(result.checks.find(check => check.id === "omp.candidate-inventory-provenance")?.status).toBe("invalid");
    expect(result.checks.find(check => check.id === "omp.candidate.settings-inventory.json")?.status).toBe("unknown");
  }), 15_000);
  test("inventory-only Codex input is supported and a false metadata version is rejected", async () => temp(async dir => {
    const native = await readJson(join(codex, "theme-defaults.json"));
    await writeFile(join(dir, "theme-defaults.json"), JSON.stringify(native.value));
    let result = await buildReport({ codexCandidate: dir });
    expect(result.checks.find(check => check.id === "codex.candidate.metadata")?.status).toBe("unknown");
    expect(result.checks.find(check => check.id === "codex.candidate.theme-defaults.json")?.status).toBe("unchanged");
    const meta = await readJson(join(codex, "reference-metadata.json")); meta.value.CFBundleShortVersionString = "fixture-wrong-version";
    await writeFile(join(dir, "reference-metadata.json"), JSON.stringify(meta.value));
    result = await buildReport({ codexCandidate: dir });
    expect(result.checks.find(check => check.id === "codex.candidate.theme-defaults.json")?.status).toBe("invalid");
    expect(result.summary.exitCode).toBe(1);
  }), 15_000);
  test("CLI rejects unknown/duplicate/missing arguments and retains explicit candidate inputs", () => {
    expect(() => parseArgs(["--download"])).toThrow("Unknown option");
    expect(() => parseArgs(["--codex-app"])).toThrow("Missing value");
    expect(() => parseArgs(["--format", "json", "--format", "markdown"])).toThrow("Duplicate option");
    expect(() => parseArgs(["--format", "html"])).toThrow("json or markdown");
    expect(parseArgs(["--omp-candidate-inventory", ".reference/omp-18.1.10", "--format", "json"]).options.ompCandidateInventory).toBe(join(reference, "omp-18.1.10"));
  });
});
