import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const EXPECTED_BUN_VERSION = "1.3.14";
const EXPECTED_OMP_VERSION = "18.1.10";
const DIRECT_OMP_PACKAGES = [
  "@oh-my-pi/pi-ai",
  "@oh-my-pi/pi-coding-agent",
  "@oh-my-pi/pi-natives",
  "@oh-my-pi/pi-tui",
  "@oh-my-pi/pi-utils",
] as const;

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
}

interface HostArtifactManifest {
  format?: unknown;
  version?: unknown;
  bunVersion?: unknown;
  ompVersion?: unknown;
  files?: unknown;
}

export interface BundledRuntimePackage {
  name: string;
  version: string;
  packageRoot: string;
  manifestPath: string;
  resolvedPath?: string;
}

export interface BundledRuntimeReport {
  hostRoot: string;
  executablePath: string;
  bunVersion: string;
  ompVersion: string;
  packages: BundledRuntimePackage[];
}

let activeRoot: string | undefined;

function fail(message: string): never {
  throw new Error(`Invalid bundled runtime: ${message}`);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function regularOwnedFile(path: string, ownerRoot: string, description: string): string {
  let physical: string;
  try {
    if (!lstatSync(path).isFile()) fail(`${description} is not a regular file`);
    physical = realpathSync(path);
    if (!statSync(physical).isFile() || !inside(ownerRoot, physical)) fail(`${description} is outside the bundled runtime`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid bundled runtime:")) throw error;
    fail(`${description} is missing or unreadable`);
  }
  return physical;
}

function objectEntries(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${description} is malformed`);
  return value as Record<string, unknown>;
}

function readJson(path: string, ownerRoot: string, description: string): Record<string, unknown> {
  const physical = regularOwnedFile(path, ownerRoot, description);
  try {
    return objectEntries(JSON.parse(readFileSync(physical, "utf8")), description);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid bundled runtime:")) throw error;
    fail(`${description} is not valid JSON`);
  }
}

function dependencyMap(value: unknown, description: string): Record<string, string> {
  if (value === undefined) return {};
  const entries = objectEntries(value, description);
  for (const [name, version] of Object.entries(entries)) {
    if (typeof version !== "string") fail(`${description} has a non-string version for ${name}`);
  }
  return entries as Record<string, string>;
}

function packageParts(name: string): string[] {
  const parts = name.split("/");
  if (parts.length !== 2 || parts[0] !== "@oh-my-pi" || !parts[1]) fail(`invalid OMP package name ${name}`);
  return parts;
}

function validatePackageLink(packagePath: string, nodeModulesRoot: string, expectedName: string): BundledRuntimePackage {
  let packageRoot: string;
  try {
    const entry = lstatSync(packagePath);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) fail(`${expectedName} package is not a directory`);
    packageRoot = realpathSync(packagePath);
    if (!statSync(packageRoot).isDirectory() || !inside(nodeModulesRoot, packageRoot)) fail(`${expectedName} package redirects outside bundled node_modules`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid bundled runtime:")) throw error;
    fail(`${expectedName} package is missing or unreadable`);
  }
  const manifestPath = regularOwnedFile(join(packageRoot, "package.json"), packageRoot, `${expectedName} manifest`);
  const manifest = readJson(manifestPath, packageRoot, `${expectedName} manifest`) as PackageManifest;
  if (manifest.name !== expectedName) fail(`${expectedName} manifest has the wrong package name`);
  if (manifest.version !== EXPECTED_OMP_VERSION) fail(`${expectedName} must be version ${EXPECTED_OMP_VERSION}`);
  return { name: expectedName, version: EXPECTED_OMP_VERSION, packageRoot, manifestPath };
}

function findDependencyLink(packageRoot: string, nodeModulesRoot: string, name: string): string | undefined {
  const parts = packageParts(name);
  const hostRoot = dirname(nodeModulesRoot);
  let cursor = packageRoot;
  while (inside(hostRoot, cursor)) {
    const candidate = join(cursor, "node_modules", ...parts);
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(`${name} dependency is unreadable`);
    }
    if (cursor === hostRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor || !inside(hostRoot, parent)) break;
    cursor = parent;
  }
  return undefined;
}

function selectedPlatformOptional(name: string): boolean {
  return name.endsWith(`-${process.platform}-${process.arch}`);
}

function resolveSdk(name: string, from: string, packageRoot: string, nodeModulesRoot: string): string {
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(Bun.resolveSync(name, from));
  } catch {
    fail(`${name} SDK entrypoint cannot be resolved from its bundled package owner`);
  }
  if (!inside(nodeModulesRoot, resolvedPath) || !inside(packageRoot, resolvedPath))
    fail(`${name} SDK entrypoint resolves outside its bundled package`);
  if (!statSync(resolvedPath).isFile()) fail(`${name} SDK entrypoint is not a regular file`);
  return resolvedPath;
}

function validateDependencyGraph(initial: BundledRuntimePackage[], nodeModulesRoot: string): BundledRuntimePackage[] {
  const byRoot = new Map(initial.map(pkg => [pkg.packageRoot, pkg]));
  const queue = [...initial];
  for (let index = 0; index < queue.length; index += 1) {
    const owner = queue[index]!;
    const manifest = readJson(owner.manifestPath, owner.packageRoot, `${owner.name} manifest`) as PackageManifest;
    const required = dependencyMap(manifest.dependencies, `${owner.name} dependencies`);
    const optional = dependencyMap(manifest.optionalDependencies, `${owner.name} optional dependencies`);
    for (const [name, pin] of [...Object.entries(required), ...Object.entries(optional)].filter(([name]) => name.startsWith("@oh-my-pi/"))) {
      if (pin !== EXPECTED_OMP_VERSION) fail(`${owner.name} does not pin ${name} to ${EXPECTED_OMP_VERSION}`);
      const link = findDependencyLink(owner.packageRoot, nodeModulesRoot, name);
      const isRequired = Object.hasOwn(required, name) || selectedPlatformOptional(name);
      if (!link) {
        if (isRequired) fail(`${owner.name} is missing bundled dependency ${name}`);
        continue;
      }
      const dependency = validatePackageLink(link, nodeModulesRoot, name);
      if (!byRoot.has(dependency.packageRoot)) {
        byRoot.set(dependency.packageRoot, dependency);
        queue.push(dependency);
      }
    }
  }
  return [...byRoot.values()].sort((left, right) => left.name.localeCompare(right.name) || left.packageRoot.localeCompare(right.packageRoot));
}

export function assertBundledRuntime(hostRoot: string, executablePath = process.execPath): BundledRuntimeReport {
  if (!isAbsolute(hostRoot) || resolve(hostRoot) !== hostRoot) fail("host root must be an absolute normalized path");
  let physicalHostRoot: string;
  try {
    physicalHostRoot = realpathSync(hostRoot);
    if (physicalHostRoot !== hostRoot || !statSync(physicalHostRoot).isDirectory()) fail("host root must be a canonical directory");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid bundled runtime:")) throw error;
    fail("host root is missing or unreadable");
  }
  const expectedNodeModulesRoot = join(hostRoot, "node_modules");
  let nodeModulesRoot: string;
  try {
    nodeModulesRoot = realpathSync(expectedNodeModulesRoot);
    if (nodeModulesRoot !== expectedNodeModulesRoot || !statSync(nodeModulesRoot).isDirectory())
      fail("node_modules must be a physical directory in the host artifact");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid bundled runtime:")) throw error;
    fail("node_modules is missing or unreadable");
  }

  const artifact = readJson(join(hostRoot, "host-artifact.json"), hostRoot, "host-artifact.json") as HostArtifactManifest;
  if (artifact.format !== 1 || typeof artifact.version !== "string" || !artifact.version
      || artifact.bunVersion !== EXPECTED_BUN_VERSION || artifact.ompVersion !== EXPECTED_OMP_VERSION
      || !artifact.files || typeof artifact.files !== "object" || Array.isArray(artifact.files))
    fail("host-artifact.json metadata does not match the packaged runtime");
  if (typeof Bun === "undefined" || Bun.version !== EXPECTED_BUN_VERSION) fail(`running Bun must be version ${EXPECTED_BUN_VERSION}`);

  if (!isAbsolute(executablePath) || resolve(executablePath) !== executablePath) fail("Bun executable path must be absolute and normalized");
  const physicalExecutable = regularOwnedFile(executablePath, dirname(hostRoot), "Bun executable");
  const installedExecutable = join(hostRoot, "bin", "bun");
  const desktopExecutable = join(dirname(hostRoot), "runtime", "bun");
  if (physicalExecutable !== installedExecutable && physicalExecutable !== desktopExecutable)
    fail("Bun executable is not owned by the host artifact");
  if ((statSync(physicalExecutable).mode & 0o111) === 0) fail("Bun executable is not executable");

  // Establish every direct package inside the artifact before asking Bun's resolver,
  // so an adjacent or globally installed package can never satisfy a missing bundle.
  const direct = DIRECT_OMP_PACKAGES.map(name => validatePackageLink(join(nodeModulesRoot, ...packageParts(name)), nodeModulesRoot, name));
  for (const pkg of direct) pkg.resolvedPath = resolveSdk(pkg.name, pkg.packageRoot, pkg.packageRoot, nodeModulesRoot);
  const packages = validateDependencyGraph(direct, nodeModulesRoot);
  return { hostRoot, executablePath: physicalExecutable, bunVersion: EXPECTED_BUN_VERSION, ompVersion: EXPECTED_OMP_VERSION, packages };
}

export function activateBundledRuntime(hostRoot: string): BundledRuntimeReport {
  const report = assertBundledRuntime(hostRoot);
  if (activeRoot !== undefined && activeRoot !== report.hostRoot) fail("a different bundled runtime is already active");
  activeRoot = report.hostRoot;
  return report;
}

export function getBundledRuntimeRoot(): string | undefined {
  return activeRoot;
}
