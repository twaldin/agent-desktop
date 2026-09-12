import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyTmuxBundle } from "../apps/host/src/terminals/bundle";
import { unpackHostArtifact } from "./install-host";

// macOS packaging deliberately uses the vendor Electron shell plus our maintained app files.
// A host source archive is provided by package-host.ts; all runtime paths are inside this app.
if (process.platform !== "darwin") throw new Error("Build the macOS desktop on a Mac.");
if (Bun.version !== "1.3.14") throw new Error("Desktop packaging requires Bun 1.3.14.");
const bunVersion = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
if (bunVersion.status !== 0 || bunVersion.stdout.trim() !== "1.3.14") throw new Error("The bundled executable must be Bun 1.3.14.");
const root = resolve(import.meta.dir, "..");
const hostArchive = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!hostArchive) throw new Error("Usage: bun scripts/package-desktop.ts <host-package.tar.gz> [output-directory]");
const output = resolve(process.argv[3] ?? "out/desktop");
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, ".package-"));
const application = join(staging, "Agent Desktop.app");
const electron = resolve(root, "node_modules/electron/dist/Electron.app");
function run(command: string, args: string[], cwd = root): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}.`);
}
try {
  // A frozen Bun install can restore package files without the vendor binary
  // populated by Electron's install script. Use that exact pinned installer.
  try { await access(electron); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    run(process.execPath, [join(root, "node_modules/electron/install.js")]);
  }
  run(process.execPath, ["scripts/build.ts"]);
  run("/bin/cp", ["-cR", electron, application]);
  const resources = join(application, "Contents/Resources");
  const appDirectory = join(resources, "app");
  await mkdir(appDirectory, { recursive: true });
  await cp(join(root, "apps/desktop/dist"), join(appDirectory, "dist"), { recursive: true });
  await mkdir(join(resources, "native"), { recursive: true });
  await cp(join(root, "apps/desktop/dist/native/modifier-release"), join(resources, "native/modifier-release"), { dereference: true });
  run("/usr/bin/codesign", ["--force", "--sign", "-", join(resources, "native/modifier-release")]);
  await rm(join(appDirectory, "dist/native"), { recursive: true, force: true });
  const desktopPackage = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
  await writeFile(join(appDirectory, "package.json"), JSON.stringify({ name: "agent-desktop", version: desktopPackage.version, main: "dist/main.cjs" }));
  const hostDirectory = join(resources, "host");
  await mkdir(hostDirectory, { recursive: true });
  // Validate archive paths, pinned metadata and every recorded source hash before installing code.
  const hostArtifact = await unpackHostArtifact(hostArchive, hostDirectory);
  if (hostArtifact.runtimeEntrypoint !== "apps/host/src/packaged-entry.ts") throw new Error("Desktop packaging requires a host with runtime ownership checks.");
  run(process.execPath, ["install", "--production", "--frozen-lockfile", "--backend=copyfile"], hostDirectory);
  await mkdir(join(resources, "runtime"));
  await cp(process.execPath, join(resources, "runtime/bun"), { dereference: true });
  const copiedVersion = spawnSync(join(resources, "runtime/bun"), ["--version"], { encoding: "utf8" });
  if (copiedVersion.status !== 0 || copiedVersion.stdout.trim() !== "1.3.14") throw new Error("Copied Bun runtime does not match 1.3.14.");
  // Test the installed source tree before producing a launchable artifact. Runtime
  // JSON catalogs and other packaged imports must not resolve through the checkout.
  run(join(resources, "runtime/bun"), ["--eval", 'const {activateBundledRuntime}=await import("./apps/host/src/runtime-ownership.ts"); activateBundledRuntime(process.cwd()); await import("./apps/host/src/server.ts"); const native = await import("@oh-my-pi/pi-natives"); if (typeof native.FileLock.tryAcquire !== "function") throw new Error("Native host lock missing");'], hostDirectory);
  const nativeBundle = verifyTmuxBundle(join(hostDirectory, "runtime/tmux", `${process.platform}-${process.arch}`));
  run(nativeBundle.binary, ["-V"]);
  await rename(join(application, "Contents/MacOS/Electron"), join(application, "Contents/MacOS/Agent Desktop"));
  const plist = join(application, "Contents/Info.plist");
  for (const [key, value] of Object.entries({ CFBundleIdentifier: "net.waldin.agent-desktop", CFBundleName: "Agent Desktop",
    CFBundleDisplayName: "Agent Desktop", CFBundleExecutable: "Agent Desktop", CFBundleShortVersionString: desktopPackage.version, CFBundleVersion: "1" })) {
    run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  }
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", application]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", application]);
  // Signing the outer shell must not silently invalidate an immutable nested runtime.
  verifyTmuxBundle(nativeBundle.directory);
  const destination = join(output, "Agent Desktop.app");
  const previous = join(output, "Agent Desktop.previous.app");
  // Preserve the previous build for rollback; these paths are build artifacts, never user data.
  await rm(previous, { recursive: true, force: true });
  try { await rename(destination, previous); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rename(application, destination);
  console.log(`Packaged desktop: ${destination}`);
} finally { await rm(staging, { recursive: true, force: true }); }
