import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { packageHost, validateVersion } from "./package-host";

const [inputVersion, inputBundles, inputOutput] = process.argv.slice(2);
if (!inputVersion || !inputBundles || !inputOutput) throw new Error("Usage: release-artifacts.ts VERSION BUNDLE_DIRECTORY NEW_OUTPUT_DIRECTORY");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Release packaging requires macOS ARM64.");
const version = validateVersion(inputVersion), bundles = resolve(inputBundles), output = resolve(inputOutput);
await mkdir(output); // Never overwrite a prior release.
const root = resolve(import.meta.dir, "..");
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited ${result.status}`);
};
const host = await packageHost({ version, output: join(output, `agent-desktop-host-${version}.tar.gz`),
  nativeBundles: [join(bundles, "darwin-arm64"), join(bundles, "linux-x64")] });
// Use a disposable runner checkout; preserve source version pins in Git itself.
const manifestPath = join(root, "apps/desktop/package.json");
const original = await readFile(manifestPath, "utf8");
const desktopOutput = join(dirname(output), `desktop-${version}`);
try {
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(original), version }, null, 2) + "\n");
  run(process.execPath, ["scripts/package-desktop.ts", host.artifact, desktopOutput]);
} finally { await writeFile(manifestPath, original); }
run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", join(desktopOutput, "Agent Desktop.app"),
  join(output, `agent-desktop-${version}-macos-arm64.zip`)]);
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (revision.status !== 0) throw new Error("Cannot determine release commit.");
await writeFile(join(output, "build.json"), JSON.stringify({ version, commit: revision.stdout.trim(),
  bun: Bun.version, omp: "18.1.10", desktop: "darwin-arm64", hosts: ["darwin-arm64", "linux-x64"],
  signing: "ad-hoc; not notarized", acceptance: "development prerelease; full milestone incomplete" }, null, 2) + "\n");
const names = (await readdir(output)).filter(name => !name.endsWith(".sha256")).sort();
const checksums = await Promise.all(names.map(async name => `${createHash("sha256").update(await readFile(join(output, name))).digest("hex")}  ${name}\n`));
await writeFile(join(output, "SHA256SUMS"), checksums.join(""));
