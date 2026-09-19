import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHostRuntimePins, validateVersion } from "./package-host";

/** Build on each target platform. No installation, profile creation, authentication or provider work. */
export async function packageManagedOmp(output: string, version: string) {
  if (Bun.version !== "1.3.14") throw new Error("Build with Bun 1.3.14.");
  validateVersion(version);
  output = resolve(output);
  try { await lstat(output); throw new Error("Refusing to overwrite an existing runtime."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  assertHostRuntimePins(manifest);
  if (!manifest.patchedDependencies?.["@oh-my-pi/pi-utils@18.1.10"]) throw new Error("Managed dotenv patch is required.");
  const files = ["package.json", "bun.lock", "apps/host/package.json", "apps/desktop/package.json", "packages/shared/package.json",
    "apps/host/src/runtime-ownership.ts", "scripts/restore-pinned-omp-cli-mode.ts", ...Object.values(manifest.patchedDependencies) as string[]];
  await mkdir(join(output, "bin"), {recursive:true});
  output = await realpath(output);
  for (const file of files) {
    if (file.includes("..") || file.startsWith("/")) throw new Error("Invalid source path.");
    await mkdir(dirname(join(output, file)), {recursive:true});
    await copyFile(join(repository, file), join(output, file));
  }
  const bun = join(output, "bin/bun");
  await copyFile(process.execPath, bun); await chmod(bun, 0o755);
  const probe = Bun.spawnSync([bun, "--version"], {stdout:"pipe",stderr:"pipe"});
  if (!probe.success || probe.stdout.toString().trim() !== "1.3.14") throw new Error("Copied Bun must be 1.3.14.");
  const install = Bun.spawn([bun,"--no-env-file","install","--production","--frozen-lockfile","--backend=copyfile"], {
    cwd:output,env:{...process.env,PI_DISABLE_DOTENV:"1"},stdout:"pipe",stderr:"pipe"});
  const [code, stdout, stderr] = await Promise.all([install.exited,new Response(install.stdout).text(),new Response(install.stderr).text()]);
  if (code !== 0) throw new Error(`Frozen install failed (${code}): ${stdout}\n${stderr}`);
  await writeFile(join(output,"host-artifact.json"), JSON.stringify({format:1,version,bunVersion:"1.3.14",ompVersion:"18.1.10",files:{}},null,2)+"\n");
  await writeFile(join(output,"managed-cli.ts"), `import { resolve } from "node:path";
import { activateBundledRuntime } from "./apps/host/src/runtime-ownership";
const root = resolve(import.meta.dir);
activateBundledRuntime(root);
if (process.env.PI_DISABLE_DOTENV !== "1" || !process.execArgv.includes("--no-env-file")) throw new Error("Use the managed omp executable.");
process.env.PI_SUBPROCESS_CMD = resolve(root, "bin/omp");
const { runCli } = await import("./node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts");
if (Bun.isMainThread) await runCli(process.argv.slice(2));
`);
  // Absolute executable selected by native resolveOmpCommand; no PATH fallback for helpers.
  await writeFile(join(output,"bin/omp"), `#!/bin/sh
set -eu
runtime_root=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && pwd -P)
case "\${PI_CODING_AGENT_DIR:-}" in /*) ;; *) echo "An explicit absolute PI_CODING_AGENT_DIR is required." >&2; exit 1;; esac
export PATH="$runtime_root/bin:\${PATH:-/usr/bin:/bin}"
export PI_DISABLE_DOTENV=1
export PI_SUBPROCESS_CMD="$runtime_root/bin/omp"
exec "$runtime_root/bin/bun" --no-env-file "$runtime_root/managed-cli.ts" "$@"
`,{mode:0o755});
  const records: Record<string,{sha256:string}|{link:string}> = {};
  async function scan(directory:string, prefix="") {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const name = prefix + entry.name, full = join(directory,entry.name);
      if (entry.isSymbolicLink()) records[name] = {link:await readlink(full)};
      else if(entry.isDirectory()) await scan(full,name+"/");
      else if(entry.isFile()) records[name] = {sha256:createHash("sha256").update(await readFile(full)).digest("hex")};
    }
  }
  await scan(output);
  const receipt={format:1,version,platform:process.platform,arch:process.arch,bunVersion:"1.3.14",ompVersion:"18.1.10",entry:"bin/omp",nativeEntry:"node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts",records};
  await writeFile(output+".receipt.json",JSON.stringify(receipt,null,2)+"\n");
  return {output,receipt:output+".receipt.json",entry:join(output,"bin/omp"),files:Object.keys(records).length};
}
if(import.meta.main) {
  const [output,version] = process.argv.slice(2);
  if (!output||!version) throw new Error("Usage: bun --no-env-file scripts/package-managed-omp.ts OUTPUT VERSION");
  console.log(JSON.stringify(await packageManagedOmp(output,version)));
}
