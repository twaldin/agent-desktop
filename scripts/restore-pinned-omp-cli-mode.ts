import { constants } from "node:fs";
import { chmod, copyFile, lstat, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const packageName = "@oh-my-pi/pi-coding-agent";
const packageVersion = "18.1.10";
const packageBin = "dist/cli.js";
const executableMode = 0o755;

type AtomicReplace = (from: string, to: string) => Promise<void>;
type RepairResult = { status: "unchanged" | "repaired"; path: string; previousMode: number; mode: number };

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function restorePinnedOmpCliMode(
  repository: string,
  atomicReplace: AtomicReplace = rename,
): Promise<RepairResult> {
  const root = await realpath(repository);
  const rootManifest = await json(join(root, "package.json"));
  if (rootManifest.dependencies?.[packageName] !== packageVersion) {
    throw new Error(`Expected ${packageName} dependency ${packageVersion}.`);
  }

  const projectNodeModules = join(root, "node_modules");
  const nodeModules = await realpath(projectNodeModules);
  if (nodeModules !== projectNodeModules) {
    throw new Error("Expected this repository's node_modules directory to be project-local.");
  }
  const selectedPackage = await realpath(join(nodeModules, packageName));
  if (!contains(nodeModules, selectedPackage)) {
    throw new Error(`Selected ${packageName} package escapes this repository's node_modules.`);
  }

  const selectedManifest = await json(join(selectedPackage, "package.json"));
  if (selectedManifest.name !== packageName || selectedManifest.version !== packageVersion) {
    throw new Error(`Expected selected ${packageName} package ${packageVersion}.`);
  }
  if (!selectedManifest.bin || typeof selectedManifest.bin !== "object" || Array.isArray(selectedManifest.bin)
    || selectedManifest.bin.omp !== packageBin || Object.keys(selectedManifest.bin).length !== 1) {
    throw new Error(`Expected ${packageName} to declare only omp: ${packageBin}.`);
  }

  const target = resolve(selectedPackage, packageBin);
  if (!contains(selectedPackage, target) || relative(selectedPackage, target) !== packageBin) {
    throw new Error(`Invalid ${packageName} omp bin path.`);
  }
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Expected ${packageName} omp bin to be a regular file.`);
  }
  if (await realpath(target) !== target) throw new Error(`Expected ${packageName} omp bin to remain inside its selected package.`);
  const previousMode = before.mode & 0o777;
  if (previousMode === executableMode) {
    return { status: "unchanged", path: target, previousMode, mode: previousMode };
  }

  const temporary = join(dirname(target), `.${basename(target)}.mode-fix-${process.pid}-${crypto.randomUUID()}`);
  try {
    await copyFile(target, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, executableMode);
    const [copied, current] = await Promise.all([lstat(temporary), lstat(target)]);
    if (!copied.isFile() || copied.isSymbolicLink()) throw new Error("Private omp bin copy is not a regular file.");
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== before.dev || current.ino !== before.ino
      || current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
      throw new Error("Selected omp bin changed while its mode was being restored.");
    }
    const [sourceBytes, copiedBytes] = await Promise.all([readFile(target), readFile(temporary)]);
    if (!sourceBytes.equals(copiedBytes)) throw new Error("Private omp bin copy changed bytes.");
    await atomicReplace(temporary, target);
    const after = await lstat(target);
    if (!after.isFile() || after.isSymbolicLink() || (after.mode & 0o777) !== executableMode
      || after.dev !== copied.dev || after.ino !== copied.ino) {
      throw new Error("Restored omp bin did not become the verified private file.");
    }
    return { status: "repaired", path: target, previousMode, mode: after.mode & 0o777 };
  } finally {
    await rm(temporary, { force: true });
  }
}

if (import.meta.main) {
  const result = await restorePinnedOmpCliMode(resolve(import.meta.dir, ".."));
  if (result.status === "repaired") console.log(`Restored ${packageName} omp bin mode to 0755.`);
}
