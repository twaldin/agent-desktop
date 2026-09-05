import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { TerminalError } from "./error";

export const TMUX_BUNDLE_SOURCES = {
  tmux: { version: "3.7c", url: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz", sha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf" },
  libevent: { version: "2.1.13-stable", url: "https://github.com/libevent/libevent/releases/download/release-2.1.13-stable/libevent-2.1.13-stable.tar.gz", sha256: "f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c" },
  ncurses: { version: "6.6", url: "https://invisible-island.net/archives/ncurses/ncurses-6.6.tar.gz", sha256: "355b4cbbed880b0381a04c46617b7656e362585d52e9cf84a67e2009b749ff11" },
  utf8proc: { version: "2.10.0", url: "https://github.com/JuliaStrings/utf8proc/releases/download/v2.10.0/utf8proc-2.10.0.tar.gz", sha256: "276a37dc4d1dd24d7896826a579f4439d1e5fe33603add786bb083cab802e23e" },
  jemalloc: { version: "5.3.1", url: "https://github.com/jemalloc/jemalloc/releases/download/5.3.1/jemalloc-5.3.1.tar.bz2", sha256: "3826bc80232f22ed5c4662f3034f799ca316e819103bdc7bb99018a421706f92" },
} as const;
export interface TmuxBundleManifest {
  schema: 1;
  protocol: "tmux-v1";
  platform: "darwin-arm64" | "linux-x64";
  sources: typeof TMUX_BUNDLE_SOURCES;
  files: Record<string, string>;
  compiler: string;
  runtimeLibraries: string[];
  minimumOS: string;
  builtAt: string;
}
export interface TmuxBundle { directory: string; binary: string; terminfo: string; digest: string; manifest: TmuxBundleManifest }
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
/** The caller selects an immutable app bundle; never discover or execute a system tmux. */
export function verifyTmuxBundle(directory: string, expectedPlatform: TmuxBundleManifest["platform"] | string = `${process.platform}-${process.arch}`): TmuxBundle {
  const root = realpathSync(directory);
  const manifestStat = lstatSync(join(root, "manifest.json"));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 128 * 1024) throw new TerminalError("INVALID_TMUX_BUNDLE", "The native terminal manifest must be a bounded regular file.");
  const raw = readFileSync(join(root, "manifest.json"));
  if (raw.byteLength > 128 * 1024) throw new TerminalError("INVALID_TMUX_BUNDLE", "The native terminal manifest is too large.");
  const manifest: TmuxBundleManifest = JSON.parse(raw.toString("utf8"));
  if (manifest.schema !== 1 || manifest.protocol !== "tmux-v1" || manifest.platform !== expectedPlatform || JSON.stringify(manifest.sources) !== JSON.stringify(TMUX_BUNDLE_SOURCES)) {
    throw new TerminalError("INCOMPATIBLE_TMUX_BUNDLE", "This native terminal bundle does not match the pinned platform and source versions.");
  }
  const files = Object.entries(manifest.files ?? {});
  if (!files.length || files.length > 256 || !manifest.files["bin/tmux"] || !files.some(([path]) => path.startsWith("terminfo/"))) throw new TerminalError("INVALID_TMUX_BUNDLE", "The native terminal bundle is incomplete.");
  let totalBytes = 0;
  for (const [path, digest] of files) {
    if (!/^[A-Za-z0-9_./+-]+$/.test(path) || path.split("/").some(part => part === ".." || !part) || !/^[a-f0-9]{64}$/.test(digest)) throw new TerminalError("INVALID_TMUX_BUNDLE", "Invalid native terminal manifest path or hash.");
    const file = join(root, path); const stat = lstatSync(file);
    totalBytes += stat.size;
    if (stat.size > 16 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) throw new TerminalError("INVALID_TMUX_BUNDLE", "The native terminal bundle exceeds its file-size bounds.");
    if (resolve(file) !== file || !stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file || sha256(readFileSync(file)) !== digest) throw new TerminalError("INVALID_TMUX_BUNDLE", `The bundled native terminal file failed verification: ${path}`);
  }
  if (!(lstatSync(join(root, "bin/tmux")).mode & 0o111)) throw new TerminalError("INVALID_TMUX_BUNDLE", "The bundled native terminal is not executable.");
  return { directory: root, binary: join(root, "bin/tmux"), terminfo: join(root, "terminfo"), digest: sha256(raw), manifest };
}
