import { afterAll, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../upstream-artifacts";
import { extractAsar } from "./asar-extract";
import { decodeInlineMap, indexPackage, inspectMap, resolveReference, sourceMapCandidates } from "./static-index";
import { inventoryBundle } from "./inventory-bundle";

const root = await mkdtemp(join(tmpdir(), "codex-static-extraction-"));
afterAll(() => rm(root, { recursive: true, force: true }));
let next = 0;
function archiveBytes(files: Record<string, any>, payload: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify({ files })), headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4); prefix.writeUInt32LE(headerSize - 4, 8); prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.alloc(headerSize - 8 - json.length), payload]);
}
function entry(bytes: Buffer, offset = 0, extra: Record<string, any> = {}) {
  return { size: bytes.length, offset: String(offset), integrity: { algorithm: "SHA256", hash: sha256(bytes), blockSize: 4,
    blocks: Array.from({ length: Math.ceil(bytes.length / 4) }, (_, i) => sha256(bytes.subarray(i * 4, (i + 1) * 4))) }, ...extra };
}
async function fixture(files: Record<string, any>, bytes: Buffer) {
  const name = String(++next), archive = join(root, name + ".asar"), output = join(root, name + "-tree"), packed = archiveBytes(files, bytes);
  await writeFile(archive, packed);
  return { archive, output, hash: sha256(packed) };
}
describe("data-only ASAR extraction", () => {
  test("verifies exact bytes, blocks, offsets, deterministic manifest and preserves executable flag without executable permissions", async () => {
    const bytes = Buffer.from("α hello\n"), f = await fixture({ "entry.js": entry(bytes, 0, { executable: true }) }, bytes);
    const a = await extractAsar(f.archive, f.output, f.hash), b = await extractAsar(f.archive, f.output + "-again", f.hash);
    expect(a).toEqual(b); expect(a.members[0]!.integrity).toBe("verified-sha256-and-blocks");
    expect(await readFile(join(f.output, "tree/entry.js"))).toEqual(bytes);
    expect((await stat(join(f.output, "tree/entry.js"))).mode & 0o111).toBe(0);
    expect(a.members[0]!.archiveOffset).toBe(a.header.dataOffset);
    await expect(extractAsar(f.archive, f.output, f.hash)).rejects.toThrow("EEXIST");
    await expect(extractAsar(f.archive, f.output + "-wrong", "0".repeat(64))).rejects.toThrow("SHA256 differs");
  });
  test("never follows links or sources unpacked siblings", async () => {
    const bytes = Buffer.from("safe"), f = await fixture({ "safe.js": entry(bytes), "external.node": { ...entry(bytes), unpacked: true }, "link.js": { link: "../../outside" } }, bytes);
    const manifest = await extractAsar(f.archive, f.output, f.hash);
    expect(manifest.members.map(m => m.status)).toEqual(["extracted", "external-unpacked", "link-declaration"]);
    await expect(access(join(f.output, "tree/external.node"))).rejects.toThrow();
    await expect(access(join(f.output, "tree/link.js"))).rejects.toThrow();
    expect(manifest.members[1]!.sha256).toBeNull(); expect(manifest.members[2]!.link).toBe("../../outside");
  });
  test("rejects traversal, normalization collisions, invalid bounds and overlap before creating output", async () => {
    const bytes = Buffer.from("abc");
    for (const files of [{ "../outside": entry(bytes) }, { "a\\b": entry(bytes) }, { "A.js": entry(bytes), "a.js": entry(bytes) }, { "é": entry(bytes), "é": entry(bytes) }, { "bad.js": entry(bytes, 999) }, { "a.js": entry(bytes), "b.js": entry(bytes, 1) }]) {
      const f = await fixture(files, bytes);
      await expect(extractAsar(f.archive, f.output, f.hash)).rejects.toThrow();
      await expect(access(f.output)).rejects.toThrow();
    }
  });
  test("rejects corrupted whole/block declarations without publishing a successful manifest", async () => {
    const bytes = Buffer.from("abcde");
    for (const corruption of ["whole", "block"]) {
      const member = entry(bytes); if (corruption === "whole") member.integrity.hash = "0".repeat(64); else member.integrity.blocks[0] = "0".repeat(64);
      const f = await fixture({ "file.js": member }, bytes);
      await expect(extractAsar(f.archive, f.output, f.hash)).rejects.toThrow("mismatch");
      expect(JSON.parse(await readFile(join(f.output, "INCOMPLETE.json"), "utf8")).error).toContain("mismatch");
      await expect(access(join(f.output, "manifest.json"))).rejects.toThrow();
    }
  });
  test("rejects truncated or invalid header before extraction", async () => {
    const path = join(root, "short.asar"), bytes = Buffer.from("not-asar"); await writeFile(path, bytes);
    await expect(extractAsar(path, path + "-out", sha256(bytes))).rejects.toThrow("Truncated ASAR header");
  });
});
describe("static source evidence", () => {
  test("supplement refuses wrong pin, records but never follows external symlinks, and copies only selected metadata", async () => {
    const bundle = join(root, "Fixture.app"), resources = join(bundle, "Contents/Resources");
    await mkdir(resources, { recursive: true });
    const archive = archiveBytes({}, Buffer.alloc(0));
    await writeFile(join(resources, "app.asar"), archive);
    await writeFile(join(resources, "owl-app.ini"), "[test]\nvalue=reference\n");
    await symlink("/unavailable-and-must-not-follow", join(resources, "outside"));
    const output = join(root, "supplement");
    await expect(inventoryBundle(bundle, output, "0".repeat(64))).rejects.toThrow("does not match");
    await expect(access(output)).rejects.toThrow();
    const result = await inventoryBundle(bundle, output, sha256(archive));
    expect(result.counts.symlinks).toBe(1); expect(result.counts.copiedMetadata).toBe(1);
    expect(result.entries.find(e => e.path.endsWith("outside"))).toMatchObject({ status: "not-followed" });
    expect(await readFile(join(output, "metadata/Contents/Resources/owl-app.ini"), "utf8")).toBe("[test]\nvalue=reference\n");
    await expect(access(join(output, "metadata/Contents/Resources/app.asar"))).rejects.toThrow();
  });
  test("source map byte offsets survive Unicode and inline sources cannot choose extraction paths", () => {
    const map = { version: 3, sources: ["../../evil.ts"], sourcesContent: ["export const x: number = 1;"], names: ["x"], mappings: "AAAA" };
    const url = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
    const bytes = Buffer.from(`const π = 1;\n//# sourceMappingURL=${url}\n`), candidates = sourceMapCandidates(bytes);
    expect(candidates[0]!.offset).toBe(Buffer.byteLength("const π = 1;\n"));
    expect(inspectMap(decodeInlineMap(url))).toMatchObject({ sources: 1, sourcesContent: 1, names: 1, mappingsBytes: 4 });
    expect(inspectMap(decodeInlineMap(url)).recovered[0]!.name).toBe("../../evil.ts");
    expect(() => decodeInlineMap("data:application/json;base64,@garbage")).toThrow("Malformed");
    expect(() => inspectMap(Buffer.from('{"version":2}'))).toThrow("Invalid");
  });
  test("maps resolve sibling names but bare imports and missing/network paths remain explicit", () => {
    const members = new Set(["webview/assets/a.js", "webview/assets/a.js.map"]);
    expect(resolveReference("webview/assets/a.js", "a.js.map", members, true)).toEqual({ status: "declared-member", path: "webview/assets/a.js.map" });
    expect(resolveReference("webview/assets/a.js", "react", members)).toEqual({ status: "bare-or-runtime-reference" });
    expect(resolveReference("webview/assets/a.js", "../../../secret", members)).toEqual({ status: "outside-archive-not-read" });
    expect(resolveReference("webview/assets/a.js", "https://example.test/a.js.map", members)).toEqual({ status: "external-url-not-fetched" });
  });
  test("actual Bun parser indexes imports without executing module or package scripts; maps recover only hash-named text", async () => {
    const sentinel = join(root, "MUST_NOT_EXIST"), map = { version: 3, sources: ["../../escape.js"], sourcesContent: ["throw new Error('do not run')"], names: [], mappings: "" };
    const script = Buffer.from(`import './dependency.js';import('./later.js');Bun.write(${JSON.stringify(sentinel)}, 'executed');const marker='α Spinner';\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`);
    const dependency = Buffer.from("export const safe=1;"), payload = Buffer.concat([script, dependency]);
    const f = await fixture({ "entry.js": entry(script), "dependency.js": entry(dependency, script.length) }, payload);
    const manifest = await extractAsar(f.archive, f.output, f.hash), counts = await indexPackage(f.output, manifest);
    expect(counts.moduleStatuses).toEqual({ parsed: 2 });
    await expect(access(sentinel)).rejects.toThrow();
    const index = JSON.parse(await readFile(join(f.output, "index.json"), "utf8"));
    expect(index.edges.some((x: any) => x.kind === "import-statement" && x.path === "dependency.js")).toBe(true);
    expect(index.edges.some((x: any) => x.kind === "dynamic-import" && x.status === "missing-from-archive")).toBe(true);
    expect(index.maps[0].recovered[0].path).toMatch(/^recovered-sources\/[a-f0-9]{64}\.txt$/);
    const features = (await readFile(join(f.output, "features.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const spinner = features.find(x => x.matched === "Spinner");
    expect(script.subarray(spinner.source.byteOffset, spinner.source.byteOffset + spinner.source.byteLength).toString()).toBe("Spinner");
  });
});
