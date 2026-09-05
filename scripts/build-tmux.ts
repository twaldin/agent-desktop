import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { TMUX_BUNDLE_SOURCES, sha256, verifyTmuxBundle, type TmuxBundleManifest } from "../apps/host/src/terminals/bundle";

/** Build only in a new private work directory. No package manager/global installation. */
export async function buildTmux(options: { workDirectory: string; outputDirectory: string; sourceCache?: string }): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== "darwin-arm64" && platform !== "linux-x64") throw new Error(`Unsupported native terminal build platform: ${platform}`);
  const work = resolve(options.workDirectory), output = resolve(options.outputDirectory);
  if (existsSync(work) || existsSync(output)) throw new Error("Native build work/output directories must be new; immutable artifacts are never overwritten.");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const prefix = join(work, "prefix"); mkdirSync(prefix);
  const log = Bun.file(join(work, "build.log")).writer();
  const env = { ...process.env, ...(process.platform === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: "13.0" } : {}), CFLAGS: "-O2 -fPIC", CXXFLAGS: "-O2 -fPIC" };
  async function run(args: string[], cwd = work, extra: Record<string, string> = {}): Promise<string> {
    log.write(`\n${JSON.stringify(args)}\n`);
    const child = Bun.spawn(args, { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
    const code = await child.exited; const [out, err] = await Promise.all([stdout, stderr]); log.write(out); log.write(err); await log.flush();
    if (code) throw new Error(`Native build failed (${code}): ${args[0]} ${args[1] ?? ""}. See ${join(work, "build.log")}`);
    return out.trim();
  }
  try {
    const sources: Record<string, string> = {};
    for (const [name, pin] of Object.entries(TMUX_BUNDLE_SOURCES)) {
      if (name === "jemalloc" && process.platform !== "darwin") continue;
      const filename = basename(pin.url), cached = options.sourceCache && join(options.sourceCache, filename);
      const data = cached && existsSync(cached) ? readFileSync(cached) : new Uint8Array(await (await fetch(pin.url)).arrayBuffer());
      if (sha256(data) !== pin.sha256) throw new Error(`Source archive hash mismatch: ${name}`);
      const archive = join(work, filename); writeFileSync(archive, data);
      const path = join(work, name); mkdirSync(path); await run(["tar", "-xf", archive, "--strip-components=1", "-C", path]); sources[name] = path;
    }
    const configure = async (name: string, args: string[], extra: Record<string, string> = {}) => { await run(["./configure", `--prefix=${prefix}`, ...args], sources[name], extra); await run(["make", "-j4"], sources[name], extra); await run(["make", "install"], sources[name], extra); };
    await configure("libevent", ["--disable-shared", "--enable-static", "--disable-openssl", "--disable-samples", "--disable-libevent-regress"]);
    await configure("ncurses", ["--without-shared", "--with-normal", "--without-debug", "--without-ada", "--without-cxx", "--without-cxx-binding", "--without-tests", "--enable-widec"]);
    await run(["make", "-j4", "libutf8proc.a"], sources.utf8proc);
    copyFileSync(join(sources.utf8proc!, "libutf8proc.a"), join(prefix, "lib/libutf8proc.a")); copyFileSync(join(sources.utf8proc!, "utf8proc.h"), join(prefix, "include/utf8proc.h"));
    if (process.platform === "darwin") await configure("jemalloc", ["--enable-shared", "--enable-static", "--disable-doc", "--with-jemalloc-prefix="]);
    const nativeEnv: Record<string, string> = {
      LIBEVENT_CORE_CFLAGS: `-I${prefix}/include`, LIBEVENT_CORE_LIBS: `${prefix}/lib/libevent_core.a`,
      LIBTINFO_CFLAGS: `-I${prefix}/include/ncursesw`, LIBTINFO_LIBS: `${prefix}/lib/libncursesw.a`,
      LIBUTF8PROC_CFLAGS: `-I${prefix}/include`, LIBUTF8PROC_LIBS: `${prefix}/lib/libutf8proc.a`,
      ...(process.platform === "darwin" ? { JEMALLOC_CFLAGS: `-I${prefix}/include`, JEMALLOC_LIBS: `${prefix}/lib/libjemalloc.2.dylib` } : {}),
    };
    await run(["./configure", `--prefix=${prefix}`, process.platform === "darwin" ? "--enable-jemalloc" : "--disable-jemalloc"], sources.tmux, nativeEnv);
    await run(["make", "-j4"], sources.tmux, nativeEnv);
    mkdirSync(join(output, "bin"), { recursive: true }); mkdirSync(join(output, "licenses")); mkdirSync(join(output, "terminfo"));
    const binary = join(output, "bin/tmux"); copyFileSync(join(sources.tmux!, "tmux"), binary); chmodSync(binary, 0o755);
    // Copy only the two terminal descriptions used by the private server and its real attachments.
    await run([join(prefix, "bin/tic"), "-x", "-e", "tmux-256color,xterm-256color", "-o", join(output, "terminfo"), join(sources.ncurses!, "misc/terminfo.src")]);
    const licenseNames: Record<string, string> = { tmux: "COPYING", libevent: "LICENSE", ncurses: "COPYING", utf8proc: "LICENSE.md", jemalloc: "COPYING" };
    for (const [name, source] of Object.entries(sources)) copyFileSync(join(source, licenseNames[name]!), join(output, "licenses", `${name}.txt`));
    let libraries: string[];
    if (process.platform === "darwin") {
      mkdirSync(join(output, "lib"));
      const allocator = join(output, "lib/libjemalloc.2.dylib"); copyFileSync(join(prefix, "lib/libjemalloc.2.dylib"), allocator);
      await run(["install_name_tool", "-id", "@rpath/libjemalloc.2.dylib", allocator]);
      await run(["install_name_tool", "-change", `${prefix}/lib/libjemalloc.2.dylib`, "@loader_path/../lib/libjemalloc.2.dylib", binary]);
      await run(["codesign", "--force", "--sign", "-", allocator]); await run(["codesign", "--verify", "--strict", allocator]);
      const otool = await run(["otool", "-L", binary]); libraries = otool.split("\n").slice(1).map(line => line.trim().split(" ")[0]!).filter(Boolean);
      if (libraries.some(path => !path.startsWith("/usr/lib/") && path !== "@loader_path/../lib/libjemalloc.2.dylib")) throw new Error("Native macOS bundle links a shared library outside its bundle or the OS.");
      await run(["codesign", "--force", "--sign", "-", binary]); await run(["codesign", "--verify", "--strict", binary]);
    } else {
      libraries = (await run(["ldd", binary])).split("\n").map(line => line.trim());
      if (libraries.some(line => /lib(event|ncurses|tinfo|utf8proc|jemalloc)/.test(line) || line.includes("not found"))) throw new Error("Native Linux bundle has an unresolved or non-system dependency.");
    }
    if (await run([binary, "-V"]) !== "tmux 3.7c") throw new Error("The compiled tmux version differs from its pin.");
    const files: Record<string, string> = {};
    function collect(path = "") { for (const item of readdirSync(join(output, path), { withFileTypes: true })) { const relative = path ? `${path}/${item.name}` : item.name; if (item.isDirectory()) collect(relative); else if (item.isFile()) files[relative] = sha256(readFileSync(join(output, relative))); else throw new Error("Bundle contains a symlink or special file."); } }
    collect();
    const manifest: TmuxBundleManifest = { schema: 1, protocol: "tmux-v1", platform, sources: TMUX_BUNDLE_SOURCES, files, compiler: await run(["cc", "--version"]), runtimeLibraries: libraries, minimumOS: process.platform === "darwin" ? "macOS 13.0 (acceptance: macOS 26.2/26.6)" : "Linux x86_64; build glibc recorded below: " + await run(["getconf", "GNU_LIBC_VERSION"]), builtAt: new Date().toISOString() };
    writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n"); verifyTmuxBundle(output);
    return output;
  } finally { await log.end(); }
}
if (import.meta.main) {
  const [workDirectory, outputDirectory, sourceCache] = process.argv.slice(2);
  if (!workDirectory || !outputDirectory) throw new Error("Usage: bun scripts/build-tmux.ts NEW_WORK_DIRECTORY NEW_OUTPUT_DIRECTORY [SOURCE_CACHE]");
  console.log(await buildTmux({ workDirectory, outputDirectory, sourceCache }));
}
