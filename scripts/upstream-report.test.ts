import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asarRows, fileEvidence, packageRoot, readJson, sourcePath } from "./upstream-artifacts";
import { capabilityRows, canonical, compareRows, settingRows, themeRows, visualRows, type Evidence } from "./upstream-inventory";
import { buildReport, parseArgs, renderMarkdown } from "./upstream-report";
const reference = resolve(import.meta.dir, "../.reference"), release = join(reference, "omp-18.1.10-release"), codex = join(reference, "codex-26.901.41600");
const fixture: Evidence = { path: "/fixture/inventory.json", sha256: "fixture-data-only" };

async function temp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "upstream-report-test-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
describe("portable static upstream report", () => {
  test("setting comparisons retain semantic changes and never evaluate expressions", () => {
    const before = { settings: [
      { path: "enabled", type: "boolean", defaultExpression: "true", ui: { condition: "visible" } },
      { path: "removed", type: "string", defaultExpression: "'old'" },
    ] };
    const after = { settings: [{ path: "enabled", type: "enum", defaultExpression: "(() => { throw new Error('MUST NOT EXECUTE') })()",
      enumValuesExpression: '["on", "off"]', ui: { condition: "changed" } }] };
    const delta = compareRows("settings", "settings", settingRows(before, fixture), settingRows(after, fixture), [fixture]);
    expect(delta.counts).toEqual({ before: 2, after: 1, added: 0, removed: 1, changed: 1 });
    expect(delta.deltas?.find(row => row.id === "enabled")?.facets).toEqual(["defaultExpression", "enumValuesExpression", "type", "ui"]);
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    expect(canonical(undefined)).not.toBe(canonical(null));
    expect(canonical("undefined")).not.toBe(canonical(undefined));
    expect(() => compareRows("duplicate", "duplicate", settingRows({ settings: [before.settings[0], before.settings[0]] }, fixture), [], [])).toThrow("Duplicate inventory identity");
    expect(() => settingRows({ settings: [{ path: "example", type: "string" }] }, fixture)).toThrow("missing defaultExpression");
    expect(() => sourcePath("/fixture", "../../config.yml")).toThrow("Invalid inventory source path");
  });
  test("capability changes distinguish optional fields, declarations and schemas from source attribution", () => {
    const before = { interfaces: { Model: { declarationExpression: "interface Model { tools?: boolean }", source: "https://example.invalid/types.ts#L1",
      fields: [{ field: "tools", typeExpressionLine: "boolean", optional: true, sourceLine: 1 }] } },
      configurationSchemas: { ModelDefinitionSchema: { properties: { "contextWindow?": "number" } } } };
    const moved = structuredClone(before); moved.interfaces.Model.source = "https://example.invalid/types.ts#L99"; moved.interfaces.Model.fields[0]!.sourceLine = 99;
    expect(compareRows("model", "model", capabilityRows(before, fixture), capabilityRows(moved, fixture), []).status).toBe("unchanged");
    moved.interfaces.Model.fields[0]!.optional = false;
    moved.interfaces.Model.declarationExpression += "\n// changed declaration";
    moved.configurationSchemas.ModelDefinitionSchema.properties["contextWindow?"] = "number > 0";
    const delta = compareRows("model", "model", capabilityRows(before, fixture), capabilityRows(moved, fixture), []);
    expect(delta.deltas?.find(row => row.id === "field:Model.tools")?.facets).toEqual(["optional"]);
    expect(delta.deltas?.find(row => row.id === "interface:Model")?.facets).toEqual(["declarationExpression"]);
    expect(delta.deltas?.find(row => row.id === "configuration:ModelDefinitionSchema.contextWindow")?.facets).toEqual(["typeExpression"]);
  });
  test("visual inventories retain repeated declarations, cascade order and font changes", () => {
    const declaration = { name: "--fixture-color", source_file: "fixture.css", source_order: 1, selector_path: ":root", rule_path: [], value_raw: "red", important: false };
    const before = { custom_property_declarations: [declaration, { ...declaration, source_order: 2, value_raw: "blue" }],
      font_face_declarations: [{ source_file: "fixture.css", declarations: [{ name: "font-family", value_raw: "Original" }] }],
      registered_custom_properties: [], statement_at_rules: [], referenced_font_resources: [] };
    const after = structuredClone(before); after.custom_property_declarations.reverse(); after.font_face_declarations[0]!.declarations[0]!.value_raw = "Replacement";
    const delta = compareRows("visual", "visual", visualRows(before, fixture), visualRows(after, fixture), []);
    expect(delta.deltas?.find(row => row.id === "token:--fixture-color")?.kind).toBe("changed");
    expect(delta.deltas?.find(row => row.id === "font:Original")?.kind).toBe("removed");
    expect(delta.deltas?.find(row => row.id === "font:Replacement")?.kind).toBe("added");
    const theme = { appearance_settings: [{ field: "mode", default_expression: "`light`" }] };
    const changed = { appearance_settings: [{ field: "mode", default_expression: "`dark`" }] };
    expect(compareRows("theme", "theme", themeRows(theme, fixture), themeRows(changed, fixture), []).deltas?.[0]?.facets).toEqual(["defaultExpression"]);
  });
  test("ASAR header parsing records declared payload metadata without executing or authenticating it", async () => temp(async dir => {
    const json = Buffer.from(JSON.stringify({ files: { nested: { files: { "must-not-run.js": { size: 999, offset: "0", executable: true } } } } }));
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4); prefix.writeUInt32LE(json.length + 8, 4); prefix.writeUInt32LE(json.length, 12);
    const file = join(dir, "fixture.asar"); await writeFile(file, Buffer.concat([prefix, json]));
    const rows = await asarRows(file);
    expect(rows).toHaveLength(1); expect(rows[0]?.id).toBe("nested/must-not-run.js");
    expect(rows[0]?.facets.size).toBe(999); expect(rows[0]?.facets.executable).toBe(true);
    expect(rows[0]?.source.note).toContain("not verified");
  }));
  test("malformed ASAR is bounded and rejected without allocating its declared payload", async () => temp(async dir => {
    const file = join(dir, "bad.asar"), header = Buffer.alloc(16);
    header.writeUInt32LE(4, 0); header.writeUInt32LE(0xfffffff0, 4); header.writeUInt32LE(0xffffffe0, 12);
    await writeFile(file, header); await expect(asarRows(file)).rejects.toThrow("Invalid ASAR header sizes");
  }));
  test("installed package lookup survives a real native import in an isolated process", async () => temp(async dir => {
    const repository = resolve(import.meta.dir, ".."), coding = await packageRoot(repository, "@oh-my-pi/pi-coding-agent");
    const source = `
      import { strict as assert } from "node:assert";
      import { realpath } from "node:fs/promises";
      import { join } from "node:path";
      import { packageRoot, readJson } from ${JSON.stringify(join(import.meta.dir, "upstream-artifacts.ts"))};
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
  test("CLI rejects unknown/duplicate/missing arguments and retains explicit candidate inputs", () => {
    expect(() => parseArgs(["--download"])).toThrow("Unknown option");
    expect(() => parseArgs(["--codex-app"])).toThrow("Missing value");
    expect(() => parseArgs(["--format", "json", "--format", "markdown"])).toThrow("Duplicate option");
    expect(() => parseArgs(["--format", "html"])).toThrow("json or markdown");
    expect(parseArgs(["--omp-candidate-inventory", ".reference/omp-18.1.10", "--format", "json"]).options.ompCandidateInventory).toBe(join(reference, "omp-18.1.10"));
  });
});
