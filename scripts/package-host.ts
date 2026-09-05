import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTmuxBundle } from "../apps/host/src/terminals/bundle";

export interface HostArtifact {
  format: 1;
  version: string;
  createdAt: string;
  bunVersion: "1.3.14";
  ompVersion: "18.1.10";
  /** Absent only in historical artifacts, whose stores read schema 1. */
  stateSchemaVersions?: number[];
  excludedSources?: string[];
  nativeTerminals?: { protocol: "tmux-v1"; platforms: Array<"darwin-arm64" | "linux-x64"> };
  files: Record<string, string>;
}

export function validateVersion(version: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(version)) throw new Error("Version must contain only letters, digits, dots, underscores and hyphens.");
  return version;
}

async function sources(directory: string, root: string, excluded: Set<string>): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "fixtures" || entry.name === "node_modules" || entry.name.endsWith(".test.ts")) continue;
    const path = join(directory, entry.name);
    if (excluded.has(relative(root, path))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Source package cannot include a symlink: ${relative(root, path)}`);
    if (entry.isDirectory()) paths.push(...await sources(path, root, excluded));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".json")) paths.push(relative(root, path));
  }
  return paths;
}

/** Keep the original workspace manifests and lockfile so frozen production installation is exact. */
export async function packageHost(options: { version: string; output: string; repository?: string; excludeSources?: string[]; nativeBundles?: string[] }): Promise<{ artifact: string; sha256: string; version: string }> {
  const version = validateVersion(options.version);
  const repository = resolve(options.repository ?? fileURLToPath(new URL("..", import.meta.url)));
  const output = resolve(options.output);
  try { await lstat(output); throw new Error("Refusing to overwrite an existing artifact."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  if (manifest.packageManager !== "bun@1.3.14" || manifest.dependencies?.["@oh-my-pi/pi-coding-agent"] !== "18.1.10"
    || manifest.dependencies?.["@oh-my-pi/pi-natives"] !== "18.1.10") throw new Error("Host runtime dependencies must match the agreed pinned versions.");
  const excluded = new Set(options.excludeSources ?? []);
  if (!options.nativeBundles?.length) throw new Error("Include the verified native terminal runtime with --tmux-bundle before packaging this host version.");
  const files = ["package.json", "bun.lock", "apps/host/package.json", "apps/desktop/package.json", "packages/shared/package.json",
    "scripts/install-host.ts", "scripts/package-host.ts", "scripts/terminal-upgrade-guard.ts", "scripts/host-state-compatibility.ts", ...await sources(join(repository, "apps/host/src"), repository, excluded),
    ...await sources(join(repository, "packages/shared/src"), repository, excluded)].sort();
  const staging = await mkdtemp(join(tmpdir(), "agent-desktop-package-"));
  try {
    const artifact: HostArtifact = { format: 1, version, createdAt: new Date().toISOString(), bunVersion: "1.3.14", ompVersion: "18.1.10", stateSchemaVersions: [1, 2, 3], excludedSources: [...excluded], files: {} };
    for (const file of files) {
      const destination = join(staging, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(repository, file), destination);
      artifact.files[file] = createHash("sha256").update(await readFile(destination)).digest("hex");
    }
    for (const directory of options.nativeBundles ?? []) {
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      if (manifest.platform !== "darwin-arm64" && manifest.platform !== "linux-x64") throw new Error("Unsupported native terminal bundle platform.");
      const bundle = verifyTmuxBundle(directory, manifest.platform);
      artifact.nativeTerminals ??= { protocol: "tmux-v1", platforms: [] };
      if (artifact.nativeTerminals.platforms.includes(bundle.manifest.platform)) throw new Error("Duplicate native terminal bundle platform.");
      artifact.nativeTerminals.platforms.push(bundle.manifest.platform);
      for (const file of ["manifest.json", ...Object.keys(bundle.manifest.files)].sort()) {
        const relative = `runtime/tmux/${bundle.manifest.platform}/${file}`, destination = join(staging, relative);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(bundle.directory, file), destination);
        artifact.files[relative] = createHash("sha256").update(await readFile(destination)).digest("hex");
      }
      verifyTmuxBundle(join(staging, "runtime/tmux", bundle.manifest.platform), bundle.manifest.platform);
    }
    await writeFile(join(staging, "host-artifact.json"), JSON.stringify(artifact, null, 2) + "\n");
    await mkdir(dirname(output), { recursive: true });
    const result = Bun.spawnSync(["tar", "--format=ustar", "--no-xattrs", "--no-acls", "-czf", output, "-C", staging, "."], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (!result.success) { await rm(output, { force: true }); throw new Error("Could not create host archive."); }
    const sha256 = createHash("sha256").update(await readFile(output)).digest("hex");
    await writeFile(`${output}.sha256`, `${sha256}  ${output.split("/").at(-1)}\n`);
    return { artifact: output, sha256, version };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const value = (name: string) => args[args.indexOf(name) + 1];
  if (!args.includes("--version") || !args.includes("--out")) throw new Error("Usage: bun scripts/package-host.ts --version VERSION --out /absolute/artifact.tar.gz --tmux-bundle DIRECTORY [--tmux-bundle DIRECTORY]");
  console.log(JSON.stringify(await packageHost({ version: value("--version")!, output: value("--out")!,
    excludeSources: args.flatMap((arg, index) => arg === "--exclude-source" ? [args[index + 1]!] : []),
    nativeBundles: args.flatMap((arg, index) => arg === "--tmux-bundle" ? [args[index + 1]!] : []),
  }), null, 2));
}
